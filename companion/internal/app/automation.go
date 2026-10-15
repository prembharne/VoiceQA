package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/native"
)

func (a *App) proposeAutomation(ctx context.Context, m native.Message) (any, error) {
	var p struct {
		Request            string              `json:"request"`
		URL                string              `json:"url"`
		Origin             string              `json:"origin"`
		Pages              []core.Page         `json:"pages"`
		AllowConsequential bool                `json:"allowConsequential"`
		APIWritesAllowed   bool                `json:"apiWritesAllowed"`
		MaxActions         int                 `json:"maxActions"`
		Conversation       []map[string]string `json:"conversation"`
	}
	if err := decode(m, &p); err != nil {
		return nil, err
	}
	if p.Request == "" || len(p.Request) > 8000 || !core.AllowedURL(p.URL, p.Origin) || len(p.Conversation) > 6 {
		return nil, errors.New("invalid automation request")
	}
	if p.MaxActions == 0 {
		p.MaxActions = 60
	}
	if p.MaxActions < 1 || p.MaxActions > 120 {
		return nil, errors.New("automation action budget must be 1-120")
	}
	for _, turn := range p.Conversation {
		if (turn["role"] != "user" && turn["role"] != "assistant") || len(turn["text"]) > 8000 {
			return nil, errors.New("invalid automation conversation")
		}
	}
	obs, err := a.browser(ctx, "", "", map[string]any{"operation": "observe", "origin": p.Origin})
	if err != nil {
		return nil, err
	}
	s := a.getSettings()
	// This is a local scope/permission record. No AI call or action plan is
	// generated before the live tool loop starts.
	plan := core.Plan{Conversation: p.Conversation, ID: core.ID(), Version: 1, Request: p.Request, URL: p.URL, Origin: p.Origin, Pages: p.Pages, Mode: "automation", PreserveViewport: true, Viewports: []core.Viewport{observedViewport(obs)}, Summary: trim(p.Request, 1800), AIProvider: s.AIProvider, Model: s.Model, CreatedAt: core.Now(), Usage: map[string]int{}, Cases: []core.Case{}, APIWritesAllowed: p.APIWritesAllowed, Automation: &core.AutomationPolicy{Live: true, MaxActions: p.MaxActions, AllowConsequential: p.AllowConsequential, Criteria: []string{}}}
	if err = core.ValidatePlan(plan); err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	return plan, a.Store.Put("plan", plan.ID, plan)
}

type automationCheck struct {
	Page        string      `json:"page,omitempty"`
	Requirement string      `json:"requirement,omitempty"`
	CriterionID int         `json:"criterionId"`
	Action      core.Action `json:"action"`
}
type automationDecision struct {
	Type    string            `json:"type"`
	Name    string            `json:"name,omitempty"`
	Args    agentArgs         `json:"args,omitempty"`
	Action  core.Action       `json:"action,omitempty"`
	Checks  []automationCheck `json:"checks,omitempty"`
	Message string            `json:"message,omitempty"`
}

func (a *App) executeAutomation(ctx context.Context, r *core.Run) {
	started := time.Now()
	defer func() {
		r.AgentPhase = ""
		r.NextStep = nil
		r.NextStepAt = ""
		r.Handoff = nil
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, err := a.browser(cleanupCtx, r.ID, "", map[string]any{"operation": "cleanup", "origin": r.Plan.Origin})
		cancel()
		if err != nil && r.Status == "passed" {
			r.Status = "needs_review"
			r.Error = "Browser cleanup could not be verified: " + err.Error()
		}
		r.CompletedAt = core.Now()
		r.DurationMS = time.Since(started).Milliseconds()
		r.TotalSteps = len(r.Steps)
		r.Diagnosis = diagnose(r)
		a.update(r)
		a.mu.Lock()
		if a.activeID == r.ID {
			a.activeID = ""
			if a.cancel != nil {
				a.cancel()
			}
			a.cancel = nil
		}
		a.mu.Unlock()
	}()
	if err := a.runAutomationHarness(ctx, r); err != nil && r.Status == "running" {
		a.setInterrupted(r, automationHarnessFailure(err))
	}
}

// Model requests are stateless. Preserve earlier page rules/results rather than
// treating action labels as memory. This bounded, sanitized ledger is persisted
// with the run so verification expectations can be traced to earlier evidence.
func rememberAutomationObservation(r *core.Run, public map[string]any) {
	snapshot := agentPublicEvidence(public)
	if controls, ok := snapshot["controls"].([]any); ok {
		for _, raw := range controls {
			if row, ok := raw.(map[string]any); ok {
				delete(row, "focused")
			}
		}
	}
	raw, _ := json.Marshal(snapshot)
	if len(r.Observations) > 0 {
		previous, _ := json.Marshal(r.Observations[len(r.Observations)-1]["evidence"])
		if bytes.Equal(raw, previous) {
			return
		}
	}
	nextID := 0
	for _, previous := range r.Observations {
		if n, err := strconv.Atoi(strings.TrimPrefix(stringField(previous, "id"), "O")); err == nil && n >= nextID {
			nextID = n + 1
		}
	}
	r.Observations = append(r.Observations, map[string]any{"id": fmt.Sprintf("O%d", nextID), "afterActions": len(r.Steps), "evidence": snapshot})
	for len(r.Observations) > 1 {
		body, _ := json.Marshal(r.Observations)
		if len(body) <= 96*1024 && len(r.Observations) <= 12 {
			break
		}
		// Retain the initial rules/goal context and the newest observed stages.
		r.Observations = append(r.Observations[:1], r.Observations[2:]...)
		r.EvidenceOmitted = true
	}
}

func validateAutomationCompletion(plan core.Plan, scope *core.Scope, checks []automationCheck) error {
	if plan.Automation.Live {
		if len(checks) < 1 || len(checks) > 20 {
			return errors.New("live completion requires 1-20 independent outcome checks covering the full request")
		}
		seen := map[string]bool{}
		for _, check := range checks {
			key := strings.ToLower(strings.TrimSpace(check.Requirement))
			page := check.Page
			if page == "" {
				page = scope.Current
			}
			dedup := page + "|" + key
			if key == "" || len(key) > 500 || seen[dedup] || check.Action.Operation != "assert" {
				return errors.New("live completion needs unique requested-outcome descriptions and assertions")
			}
			seen[dedup] = true
			checkScope, err := automationCheckScope(scope, check.Page)
			if err != nil {
				return err
			}
			if err := core.ValidateAutomationAction(plan, checkScope, check.Action); err != nil {
				return err
			}
		}
		return nil
	}
	if len(checks) != len(plan.Automation.Criteria) {
		return errors.New("completion must independently verify every approved success criterion")
	}
	seen := map[int]bool{}
	for _, check := range checks {
		if check.CriterionID < 1 || check.CriterionID > len(plan.Automation.Criteria) || seen[check.CriterionID] || check.Action.Operation != "assert" {
			return errors.New("completion requires one unique assert per approved criterion")
		}
		seen[check.CriterionID] = true
		checkScope, err := automationCheckScope(scope, check.Page)
		if err != nil {
			return err
		}
		if err := core.ValidateAutomationAction(plan, checkScope, check.Action); err != nil {
			return err
		}
	}
	return nil
}

func automationCheckScope(scope *core.Scope, page string) (*core.Scope, error) {
	copy := scope.Clone()
	if page != "" {
		if copy.Origins[page] == "" {
			return nil, errors.New("completion check targets an unknown or closed page alias")
		}
		copy.Current = page
	}
	return copy, nil
}

func automationCompletionCost(current string, checks []automationCheck) int {
	cost := len(checks)
	for _, check := range checks {
		page := check.Page
		if page == "" {
			page = current
		}
		if page != current {
			cost++
			current = page
		}
	}
	return cost
}

func normalizeAutomationOptionals(action *core.Action) {
	if action.Operation != "http_check" && action.HTTP != nil && *action.HTTP == (core.HTTPCheck{}) {
		action.HTTP = nil
	}
	if action.Operation != "assert" && action.Operation != "wait_for" && action.Assertion != nil && *action.Assertion == (core.Assertion{}) {
		action.Assertion = nil
	}
}
func (a *App) runAutomationAction(ctx context.Context, r *core.Run, action core.Action, viewport, page string) error {
	idx, err := a.beginStep(ctx, r, action, "Adaptive browser automation", viewport, page)
	if err != nil {
		return err
	}
	result, err := a.executeAdvanced(ctx, r, idx, action)
	r.Steps[idx].CompletedAt = core.Now()
	r.Steps[idx].Result = result
	r.Steps[idx].Status = "passed"
	if actualPage, ok := result["page"].(string); ok && actualPage != "" {
		r.Steps[idx].Page = actualPage
	}
	if err != nil {
		r.Steps[idx].Status = "error"
		r.Steps[idx].Error = err.Error()
		var browser *BrowserError
		if errors.As(err, &browser) {
			r.Steps[idx].Status = browser.Code
			if browser.Code == "assertion_failed" {
				r.Steps[idx].Status = "failed"
			}
		}
	}
	if err == nil && action.Operation == "capture_value" {
		r.Values[action.Value], _ = result["value"].(string)
	}
	if err == nil && action.HTTP != nil && action.HTTP.SaveAs != "" {
		r.Values[action.HTTP.SaveAs], _ = result["value"].(string)
	}
	if action.Operation == "assert" || err != nil {
		settings := a.getSettings()
		capture, captureErr := a.browser(ctx, r.ID, "", map[string]any{"operation": "capture", "origin": r.Plan.Origin, "maskSelectors": settings.MaskSelectors, "visualMaskSelectors": settings.VisualMaskSelectors})
		if captureErr != nil && err == nil {
			err = &BrowserError{Code: "needs_review", Message: "Outcome checked but evidence capture failed: " + captureErr.Error()}
		}
		if captureErr == nil {
			if r.Steps[idx].Result == nil {
				r.Steps[idx].Result = map[string]any{}
			}
			r.Steps[idx].Result["capture"] = capture
		}
	}
	a.update(r)
	if r.Status == "error" {
		return errors.New(r.Error)
	}
	return err
}
func (a *App) setAutomationFailure(r *core.Run, err error) {
	var browser *BrowserError
	if errors.As(err, &browser) && browser.Code == "assertion_failed" {
		r.Status = "failed"
		r.Error = err.Error()
		return
	}
	a.setInterrupted(r, err)
}

// Correct a mismatched target only when the original expected text is already
// present in exactly one observed result. Never change an expected value to pass.
func normalizeAutomationCheckTargets(checks []automationCheck, obs map[string]any) {
	results, _ := obs["results"].([]any)
	for i := range checks {
		a := &checks[i].Action
		if strings.HasPrefix(a.Target, "role:") {
			role, wanted, hasName := strings.Cut(strings.TrimPrefix(a.Target, "role:"), "|")
			if a.Operation == "assert" && hasName && wanted == "" && semanticRolePattern.MatchString(role) && a.Assertion != nil && (a.Assertion.Kind == "count" || a.Assertion.Kind == "hidden" || (a.Assertion.Kind == "visible" && a.Assertion.Expected == "false")) {
				// Absence/count checks intentionally have no accessible name.
				// Compile the semantic set into a literal bounded CSS selector.
				a.Target = fmt.Sprintf(`[role="%s"]`, role)
			}
			candidates := []string{}
			if hasName {
				for _, raw := range results {
					if row, ok := raw.(map[string]any); ok && strings.EqualFold(fmt.Sprint(row["text"]), wanted) {
						if target, ok := row["target"].(string); ok && target != "" {
							candidates = append(candidates, target)
						}
					}
				}
			}
			if len(candidates) == 1 {
				a.Target = candidates[0]
			}
		}
		if a.Assertion == nil || (a.Assertion.Kind != "text" && a.Assertion.Kind != "text_contains") {
			continue
		}
		matches := func(text string) bool {
			if a.Assertion.Kind == "text" {
				return text == a.Assertion.Expected
			}
			return strings.Contains(strings.ToLower(text), strings.ToLower(a.Assertion.Expected))
		}
		currentPresent := false
		candidates := []string{}
		for _, raw := range results {
			row, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			target, _ := row["target"].(string)
			text, _ := row["text"].(string)
			if target == a.Target {
				currentPresent = true
			}
			if target != "" && matches(text) {
				candidates = append(candidates, target)
			}
		}
		// An observed target with the wrong result is a potential application
		// defect. Never move its check to another element just because that
		// element happens to contain the expectation.
		if !currentPresent && len(candidates) == 1 {
			a.Target = candidates[0]
		}
	}
}

var observedNumberPattern = regexp.MustCompile(`[+-]?(?:[0-9][0-9,]*(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?`)
var semanticRolePattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)

func (a *App) preflightAutomationAssertion(ctx context.Context, r *core.Run, action core.Action) error {
	if action.Assertion == nil {
		return errors.New("assertion expectation missing")
	}
	switch action.Assertion.Kind {
	case "url", "url_contains", "no_overflow", "count", "hidden":
		return nil
	case "visible":
		if action.Assertion.Expected == "false" {
			return nil
		}
	}
	meta, err := a.browser(ctx, r.ID, "", map[string]any{"operation": "resolve_target", "target": action.Target, "origin": r.Plan.Origin})
	if err != nil {
		return fmt.Errorf("Verification target is not present in current state; select an actual observed result target without changing the expected outcome: %w", err)
	}
	if text, ok := meta["text"].(string); ok {
		if err := validateQuotedOutcome(r, action, text); err != nil {
			return err
		}
	}
	if action.Assertion.Kind == "number" {
		text, _ := meta["text"].(string)
		if text != "" && len(observedNumberPattern.FindAllString(text, -1)) != 1 {
			return errors.New("This result contains multiple numbers. Select a single-number result, or verify the precisely formatted expected amount with text_contains. Never change the expected amount to match the page.")
		}
	}
	return nil
}

func automationStateFingerprint(action core.Action, state map[string]any) string {
	action.Label = ""
	action.TimeoutMS = 0
	if action.Operation != "key" {
		// Focus alone does not prove that a click/fill advanced the workflow.
		// Observation priority may move the focused control to the front.
		encoded, _ := json.Marshal(state)
		var cloned map[string]any
		_ = json.Unmarshal(encoded, &cloned)
		state = cloned
		if controls, ok := state["controls"].([]any); ok {
			for _, raw := range controls {
				if row, ok := raw.(map[string]any); ok {
					delete(row, "focused")
				}
			}
			sort.SliceStable(controls, func(i, j int) bool {
				a, _ := json.Marshal(controls[i])
				b, _ := json.Marshal(controls[j])
				return string(a) < string(b)
			})
		}
	}
	raw, _ := json.Marshal(struct {
		Action core.Action
		State  map[string]any
	}{action, state})
	return fmt.Sprintf("%x", sha256.Sum256(raw))
}

func automationReplayBlocked(action core.Action, state map[string]any, seen map[string]bool) bool {
	return action.Operation != "assert" && action.Operation != "wait_for" && action.Operation != "switch_tab" && seen[automationStateFingerprint(action, state)]
}
