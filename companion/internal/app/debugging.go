package app

import (
	"errors"
	"fmt"
	"strings"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/native"
)

func diagnose(r *core.Run) *core.Diagnosis {
	if r.Status == "passed" {
		return nil
	}
	if r.Status == "cancelled" {
		return &core.Diagnosis{Category: "cancelled", Summary: "The run was stopped; completed application changes remain.", NextCheck: "Review the partial evidence before starting a new run."}
	}
	hasMeasuredFailure := false
	for _, step := range r.Steps {
		if step.Status == "failed" {
			hasMeasuredFailure = true
			break
		}
	}
	for _, step := range r.Steps {
		if step.Status == "passed" || (step.Status == "wait_timeout" || step.Status == "wait_changed") && hasMeasuredFailure {
			continue
		}
		d := &core.Diagnosis{Category: "assertion", Summary: "Observed behavior did not match the reviewed expectation.", NextCheck: "Check the expected business rule and the recorded application state.", StepID: step.ID}
		switch {
		case step.Status == "wait_timeout" || step.Status == "wait_changed":
			d.Category = "readiness_timeout"
			d.Summary = "A readiness condition timed out; this does not establish that the application operation failed."
			if step.Status == "wait_changed" {
				d.Category = "readiness_changed"
				d.Summary = "The status changed without satisfying the readiness condition; its actual outcome still requires verification."
			}
			d.NextCheck = "Inspect the recorded wait duration, selector and fresh status. A busy control may have changed its accessible name. Do not repeat the operation merely because its wait expired."
		case step.Result["actual"] == "target missing" || strings.Contains(step.Error, "target missing"):
			d.Category = "target_or_evidence"
			d.Summary = "The expected element was not found, so its value was not measured."
			d.NextCheck = "Check the action order and selector. A missing review element after submission is not evidence that the order amount is incorrect."
		case step.Action.Operation == "http_check" && step.Status != "failed":
			d.Category = "api_context"
			d.Summary = "The API check could not produce a complete server-response verdict."
			d.NextCheck = "Inspect the named authentication or CSRF source, approved origin, redirect behavior and timeout before rerunning."
		case step.Action.Operation == "http_check" && step.Status == "failed":
			d.Category = "server_logic"
			d.Summary = "The server response contradicted the expected status or public data value."
			d.NextCheck = "Reproduce with the same test account, resource ID and payload; inspect server authorization and business-rule enforcement."
		case step.Action.Assertion != nil && step.Action.Assertion.Kind == "no_overflow":
			d.Category = "layout"
			d.NextCheck = "Inspect the captured viewport and overflowing elements."
		case step.Action.Operation == "accessibility":
			d.Category = "accessibility"
			d.NextCheck = "Inspect the reported axe rule and affected elements."
		case step.Status == "target_missing" || step.Status == "needs_review":
			d.Category = "target_or_evidence"
			d.NextCheck = "Check whether the selector, page state or approved visual baseline changed."
		case step.Status == "blocked":
			d.Category = "scope_or_session"
			d.NextCheck = "Check the active tab, approved origins and credential-profile origin."
		}
		if capture, ok := step.Result["capture"].(map[string]any); ok {
			if events, ok := capture["network"].([]any); ok {
				for _, event := range events {
					entry, ok := event.(map[string]any)
					if !ok {
						continue
					}
					status, _ := entry["status"].(float64)
					if status >= 500 {
						d.Category = "backend_response"
						d.Summary = "A server error was observed near the failed check."
						d.NextCheck = "Inspect the failing response in network evidence and correlate it with server logs."
						break
					}
					if (status == 401 || status == 403) && step.Action.Operation != "http_check" {
						d.Category = "authentication_or_authorization"
						d.NextCheck = "Check whether the test session expired or the server denied the requested operation."
					}
				}
			}
		}
		return d
	}
	if len(r.SecurityFindings) > 0 {
		return &core.Diagnosis{Category: "security_configuration", Summary: "Configuration indicators require review; they do not establish an exploitable vulnerability.", NextCheck: "Validate each finding against the application's intended authentication and browser policies."}
	}
	return &core.Diagnosis{Category: r.Status, Summary: r.Error, NextCheck: "Inspect the partial run and evidence before deciding whether to rerun."}
}

type comparison struct {
	Label     string `json:"label"`
	Case      string `json:"case"`
	Page      string `json:"page"`
	Viewport  string `json:"viewport"`
	Iteration int    `json:"iteration"`
	Before    string `json:"before"`
	After     string `json:"after"`
	Change    string `json:"change"`
}

func (a *App) compareRuns(m native.Message) (any, error) {
	var p struct {
		Before string `json:"before"`
		After  string `json:"after"`
	}
	if e := decode(m, &p); e != nil {
		return nil, e
	}
	var before, after core.Run
	if e := a.Store.Get("run", p.Before, &before); e != nil {
		return nil, e
	}
	if e := a.Store.Get("run", p.After, &after); e != nil {
		return nil, e
	}
	if before.Plan.Origin != after.Plan.Origin {
		return nil, errors.New("compare runs from the same approved main origin")
	}
	type stepKey struct {
		Case, Label, Page, Viewport string
		Iteration, Occurrence       int
	}
	keys := func(steps []core.Step) []stepKey {
		seen := map[stepKey]int{}
		out := make([]stepKey, len(steps))
		for i, s := range steps {
			page, row := s.Page, s.Iteration
			if page == "" {
				page = "main"
			}
			if row == 0 {
				row = 1
			}
			base := stepKey{Case: s.Case, Label: s.Action.Label, Page: page, Viewport: s.Viewport, Iteration: row}
			out[i] = base
			out[i].Occurrence = seen[base]
			seen[base]++
		}
		return out
	}
	beforeKeys, afterKeys := keys(before.Steps), keys(after.Steps)
	prior := map[stepKey]core.Step{}
	for i, s := range before.Steps {
		prior[beforeKeys[i]] = s
	}
	entries := []comparison{}
	for i, s := range after.Steps {
		old, ok := prior[afterKeys[i]]
		change := "unchanged"
		if !ok {
			change = "added"
		} else if old.Status == "passed" && s.Status != "passed" {
			change = "regressed"
		} else if old.Status != "passed" && s.Status == "passed" {
			change = "fixed"
		} else if old.Status != s.Status {
			change = "changed"
		}
		entries = append(entries, comparison{s.Action.Label, s.Case, s.Page, s.Viewport, s.Iteration, old.Status, s.Status, change})
		delete(prior, afterKeys[i])
	}
	for i, s := range before.Steps {
		if _, remains := prior[beforeKeys[i]]; remains {
			entries = append(entries, comparison{Label: s.Action.Label, Case: s.Case, Page: s.Page, Viewport: s.Viewport, Iteration: s.Iteration, Before: s.Status, Change: "removed"})
		}
	}
	return map[string]any{"before": before.ID, "after": after.ID, "entries": entries, "scope": "Matched case, label, page, viewport and data-row index; changed input data can explain differences."}, nil
}

func bugReport(r core.Run) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# VoiceQA bug report\n\nStatus: %s\n\nRun: %s\n\nWebsite: %s\n\nRequest: %s\n\n", r.Status, r.ID, r.Plan.URL, r.Plan.Request)
	if r.Diagnosis != nil {
		fmt.Fprintf(&b, "## Evidence-based triage\n\nCategory: %s\n\n%s\n\nNext check: %s\n\n", r.Diagnosis.Category, r.Diagnosis.Summary, r.Diagnosis.NextCheck)
	}
	b.WriteString("## Reproduction steps\n\n")
	for i, s := range r.Steps {
		fmt.Fprintf(&b, "%d. [%s] %s (%s, %s, data row %d)\n", i+1, s.Status, s.Action.Label, s.Page, s.Viewport, s.Iteration)
		if s.Error != "" {
			fmt.Fprintf(&b, "   Observed: %s\n", s.Error)
		}
		if s.Action.HTTP != nil {
			fmt.Fprintf(&b, "   Request: %s %s; expected HTTP %d\n", s.Action.HTTP.Method, s.Action.HTTP.URL, s.Action.HTTP.ExpectedStatus)
		}
	}
	b.WriteString("\n## Scope\n\nThis report records reviewed expectations and observed browser/server behavior. A likely triage category is not a proven root cause. Export HTML/JSON for screenshots and complete bounded network evidence.\n")
	return b.String()
}
