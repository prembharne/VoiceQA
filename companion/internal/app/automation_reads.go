package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"voiceqa/companion/internal/core"
)

const automationReadBudget = 24

func validateAutomationSubmission(meta map[string]any) error {
	form, _ := meta["nativeForm"].(map[string]any)
	if form["valid"] != false {
		return nil
	}
	// The extension returns constraints/flags only, never field values or
	// site-provided validation strings which may contain private input.
	encoded, _ := json.Marshal(form)
	return fmt.Errorf("Native form validation would prevent submission. No submit was dispatched. Inspect the reported fields and correct the invalid input before continuing: %s", recordedText(string(encoded), 3500))
}

func validateResolvedAutomationControl(action core.Action, meta map[string]any) error {
	tag := strings.ToUpper(stringField(meta, "tag"))
	if action.Operation == "select" && tag != "SELECT" {
		return errors.New("select is only for native SELECT controls. This resolved target is a custom control/option: use click on the exact currently observed control instead. No click or selection was dispatched")
	}
	if action.Operation == "fill" || action.Operation == "fill_secret" || action.Operation == "fill_totp" {
		if tag != "INPUT" && tag != "TEXTAREA" && meta["editable"] != true {
			return errors.New("fill requires an editable text control; no click or text was dispatched")
		}
		if tag == "INPUT" {
			switch strings.ToLower(stringField(meta, "inputType")) {
			case "checkbox", "radio", "button", "submit", "reset", "image", "file", "color", "range", "hidden":
				return errors.New("This input is not a text-entry control. Use an appropriate supported action; no click or text was dispatched")
			}
		}
	}
	return nil
}

func recordedAutomationCandidate(d automationDecision) map[string]any {
	if d.Type != "tool" {
		return recordedStepEvidence(core.Step{Action: d.Action})
	}
	return map[string]any{"type": "tool", "name": recordedText(d.Name, 50), "args": map[string]any{"page": recordedText(d.Args.Page, 80), "target": recordedText(d.Args.Target, 500), "query": recordedText(d.Args.Query, 200), "url": recordedText(d.Args.URL, 500)}}
}

func validateAutomationRead(plan core.Plan, current string, d automationDecision, used int) error {
	if plan.Automation == nil || !plan.Automation.Live || used >= automationReadBudget {
		return errors.New("Live read tools are unavailable or their 24-call budget is exhausted")
	}
	if d.Args.Page != current || d.Args.URL != "" || d.Action != (core.Action{}) || len(d.Checks) != 0 || d.Message != "" {
		return errors.New("Read tools accept only the current page alias and their declared arguments; switch_tab first for another page")
	}
	switch d.Name {
	case "inspect_element":
		if strings.TrimSpace(d.Args.Target) == "" || len(d.Args.Target) > 500 || d.Args.Query != "" {
			return errors.New("inspect_element needs one target of 1-500 characters, without a query or URL")
		}
	case "search_page":
		if strings.TrimSpace(d.Args.Query) == "" || len(d.Args.Query) > 200 || d.Args.Target != "" {
			return errors.New("search_page needs a phrase of 1-200 characters, without a target or URL")
		}
	case "diagnostics", "accessibility":
		if d.Args.Target != "" || d.Args.Query != "" {
			return errors.New("This read accepts only the current page alias")
		}
	default:
		return errors.New("Unknown live read tool; use inspect_element, search_page, diagnostics or accessibility")
	}
	return nil
}

func automationReadFingerprint(d automationDecision, state map[string]any, afterActions int) string {
	// An action can change constraints omitted from the broad snapshot. Allow
	// fresh inspection after it, while rejecting same-stage read-only loops.
	return fmt.Sprintf("%d:%s", afterActions, automationStateFingerprint(core.Action{Operation: "read_" + d.Name, Target: d.Args.Target, Value: d.Args.Query}, state))
}

func rememberAutomationRead(r *core.Run, evidence map[string]any) {
	r.ReadEvidence = append(r.ReadEvidence, map[string]any{"id": fmt.Sprintf("R%d", len(r.ReadEvidence)+1), "afterActions": len(r.Steps), "evidence": agentPublicEvidence(evidence)})
	for {
		encoded, _ := json.Marshal(r.ReadEvidence)
		if len(encoded) <= 48*1024 {
			return
		}
		removed := false
		for i := 1; i < len(r.ReadEvidence); i++ {
			data := r.ReadEvidence[i]["evidence"].(map[string]any)
			if data["detailsOmitted"] != true {
				r.ReadEvidence[i]["evidence"] = map[string]any{"tool": data["tool"], "page": data["page"], "detailsOmitted": true}
				removed = true
				break
			}
		}
		if !removed {
			data := r.ReadEvidence[0]["evidence"].(map[string]any)
			r.ReadEvidence[0]["evidence"] = map[string]any{"tool": data["tool"], "page": data["page"], "detailsOmitted": true}
		}
		r.EvidenceOmitted = true
	}
}
