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
	"voiceqa/companion/internal/provider"
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
	scope, err := core.NewScope(r.Plan, "main")
	if err != nil {
		a.setInterrupted(r, err)
		return
	}
	a.update(r)
	if r.Status == "error" {
		return
	}
	r.Values = map[string]string{}
	view, err := a.browser(ctx, r.ID, "", map[string]any{"operation": "current_viewport", "origin": r.Plan.Origin})
	if err != nil {
		a.setInterrupted(r, err)
		return
	}
	v := observedViewport(view)
	label := fmt.Sprintf("%dx%d", v.Width, v.Height)
	profiles, err := a.authList()
	if err != nil {
		a.setInterrupted(r, err)
		return
	}
	allowedProfiles := []AuthProfile{}
	for _, profile := range profiles {
		if scope.Approved[profile.Origin] {
			allowedProfiles = append(allowedProfiles, profile)
		}
	}
	seen := map[string]bool{}
	for len(r.Steps) < r.Plan.Automation.MaxActions {
		if err = ctx.Err(); err != nil {
			a.setInterrupted(r, err)
			return
		}
		r.AgentPhase = "Observing the current page"
		a.update(r)
		if r.Status == "error" {
			return
		}
		obs, observeErr := a.browser(ctx, r.ID, "", map[string]any{"operation": "observe", "origin": r.Plan.Origin})
		if observeErr != nil {
			a.setInterrupted(r, observeErr)
			return
		}
		public := agentPublicEvidence(obs)
		rememberAutomationObservation(r, public)
		var decision automationDecision
		validation := ""
		for attempt := 0; attempt < 3; attempt++ {
			r.AgentPhase = "Choosing the next action"
			a.update(r)
			if r.Status == "error" {
				return
			}
			history := r.Steps
			if len(history) > 12 {
				history = history[len(history)-12:]
			}
			schema := provider.AutomationStepSchema(len(r.Plan.Automation.Criteria))
			if r.Plan.Automation.Live {
				aliases := []string{""}
				for alias := range scope.Origins {
					aliases = append(aliases, alias)
				}
				sort.Strings(aliases)
				schema = provider.AutomationLiveStepSchema(aliases...)
			}
			raw, usage, e := a.aiClient(r.Plan.AIProvider).PlanStructured(ctx, a.keyFor(r.Plan.AIProvider), r.Plan.Model, provider.AutomationInstructions, map[string]any{"goal": r.Plan.Request, "conversation": r.Plan.Conversation, "successCriteria": r.Plan.Automation.Criteria, "permissions": r.Plan.Automation, "apiWritesAllowed": r.Plan.APIWritesAllowed, "scope": scope, "observation": public, "navigationChoices": automationNavigationChoices(scope, obs), "observedStateHistory": r.Observations, "earlierEvidenceOmitted": r.EvidenceOmitted, "recentSteps": agentPublicEvidence(map[string]any{"steps": history})["steps"], "publicValues": r.Values, "credentialProfiles": allowedProfiles, "remainingActions": r.Plan.Automation.MaxActions - len(r.Steps), "validationError": validation}, schema, nil)
			for key, n := range usage {
				r.Usage[key] += n
			}
			if e != nil {
				a.setInterrupted(r, agentResponseError(e, "next tool decision", true))
				return
			}
			var packet struct {
				Result automationDecision `json:"result"`
			}
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.DisallowUnknownFields()
			e = decoder.Decode(&packet)
			decision = packet.Result
			if e == nil {
				normalizeAutomationOptionals(&decision.Action)
				for i := range decision.Checks {
					normalizeAutomationOptionals(&decision.Checks[i].Action)
				}
			}
			if e == nil && decision.Type == "action" {
				normalizeAutomationTab(&decision.Action, scope, obs)
				compiled := []core.Case{{Steps: []core.Action{{Operation: "navigate", Value: fmt.Sprint(obs["url"])}, decision.Action}}}
				e = normalizeDraftControls(compiled, obs)
				decision.Action = compiled[0].Steps[1]
				if decision.Action.Operation == "assert" {
					single := []automationCheck{{Action: decision.Action}}
					normalizeAutomationCheckTargets(single, obs)
					decision.Action = single[0].Action
				}
				if e == nil {
					var resolved core.Action
					resolved, e = core.ResolveAction(decision.Action, r.Values)
					if e == nil {
						decision.Action = resolved
						e = core.ValidateAutomationAction(r.Plan, scope.Clone(), decision.Action)
						if e == nil && (decision.Action.Operation == "click" || decision.Action.Operation == "fill" || decision.Action.Operation == "select" || decision.Action.Operation == "fill_secret" || decision.Action.Operation == "fill_totp" || decision.Action.Operation == "capture_value") {
							var meta map[string]any
							meta, e = a.browser(ctx, r.ID, "", map[string]any{"operation": "resolve_target", "target": decision.Action.Target, "origin": r.Plan.Origin})
							if e == nil && decision.Action.Operation == "click" && meta["submissionAlreadyDispatched"] == true {
								e = errors.New("Unchanged form inputs were already submitted. Do not click submit again; inspect the actual result or advance to the next requested page")
							}
							if e != nil {
								e = fmt.Errorf("The proposed control is not currently actionable. Do not guess a later-stage field. Use the actual current controls and advance this stage first. Details: %w", e)
							}
						}
					}
				}
			} else if e == nil && decision.Type == "complete" {
				for i := range decision.Checks {
					resolved, resolveErr := core.ResolveAction(decision.Checks[i].Action, r.Values)
					if resolveErr != nil {
						e = resolveErr
						break
					}
					decision.Checks[i].Action = resolved
				}
				if e == nil {
					for i := range decision.Checks {
						if decision.Checks[i].Page == "" {
							decision.Checks[i].Page = scope.Current
						}
						if decision.Checks[i].Page == scope.Current {
							normalizeAutomationCheckTargets(decision.Checks[i:i+1], obs)
						}
					}
					e = validateAutomationCompletion(r.Plan, scope, decision.Checks)
				}
				if e == nil && r.Plan.Automation.Live {
					e = a.auditLiveCompletion(ctx, r, public, decision.Checks)
					var measured *BrowserError
					if errors.As(e, &measured) && measured.Code == "assertion_failed" {
						a.setAutomationFailure(r, e)
						return
					}
				}
			} else if e == nil && decision.Type != "blocked" {
				e = errors.New("choose action, complete or blocked")
			}
			if e == nil && decision.Type == "action" && decision.Action.Operation == "assert" {
				e = a.preflightAutomationAssertion(ctx, r, decision.Action)
			}
			if e == nil && decision.Type == "complete" {
				for _, check := range decision.Checks {
					if check.Page != scope.Current {
						continue
					}
					if e = a.preflightAutomationAssertion(ctx, r, check.Action); e != nil {
						break
					}
				}
			}
			if e == nil {
				break
			}
			repeated := validation == e.Error()
			validation = e.Error()
			if len(r.DecisionErrors) < 8 {
				r.DecisionErrors = append(r.DecisionErrors, map[string]any{"afterActions": len(r.Steps), "error": recordedText(validation, 1200), "candidate": recordedStepEvidence(core.Step{Action: decision.Action})})
			}
			if repeated || attempt == 2 {
				a.setInterrupted(r, &BrowserError{Code: "blocked", Message: "Adaptive decision failed validation: " + validation})
				return
			}
		}
		r.AgentPhase = ""
		if decision.Type == "blocked" {
			a.setInterrupted(r, &BrowserError{Code: "blocked", Message: decision.Message})
			return
		}
		if decision.Type == "complete" {
			if len(r.Steps)+automationCompletionCost(scope.Current, decision.Checks) > r.Plan.Automation.MaxActions {
				a.setInterrupted(r, &BrowserError{Code: "blocked", Message: "Not enough action budget remains for every success criterion"})
				return
			}
			for _, check := range decision.Checks {
				if check.Page != scope.Current {
					switchAction := core.Action{Operation: "switch_tab", Target: check.Page, Label: "Switch to " + check.Page + " for outcome verification"}
					if err = core.ValidateAutomationAction(r.Plan, scope.Clone(), switchAction); err != nil {
						a.setInterrupted(r, err)
						return
					}
					if err = a.runAutomationAction(ctx, r, switchAction, label, scope.Current); err != nil {
						a.setAutomationFailure(r, err)
						return
					}
					if err = scope.Advance(switchAction); err != nil {
						a.setInterrupted(r, err)
						return
					}
				}
				fresh, observeErr := a.browser(ctx, r.ID, "", map[string]any{"operation": "observe", "origin": r.Plan.Origin})
				if observeErr != nil {
					a.setInterrupted(r, observeErr)
					return
				}
				if page, ok := fresh["page"].(string); ok && page != "" && page != check.Page {
					a.setInterrupted(r, &BrowserError{Code: "needs_review", Message: "Verification page changed before its fresh observation"})
					return
				}
				rememberAutomationObservation(r, agentPublicEvidence(fresh))
				one := []automationCheck{check}
				normalizeAutomationCheckTargets(one, fresh)
				check = one[0]
				if err = a.preflightAutomationAssertion(ctx, r, check.Action); err != nil {
					a.setAutomationFailure(r, err)
					return
				}
				criterion := check.Requirement
				if !r.Plan.Automation.Live {
					criterion = r.Plan.Automation.Criteria[check.CriterionID-1]
				}
				criterionLabel := []rune(criterion)
				if len(criterionLabel) > 180 {
					criterionLabel = append(criterionLabel[:180], '…')
				}
				check.Action.Label = fmt.Sprintf("Verify criterion %d: %s", check.CriterionID, string(criterionLabel))
				if r.Plan.Automation.Live {
					check.Action.Label = "Verify outcome: " + string(criterionLabel)
				}
				if err = a.runAutomationAction(ctx, r, check.Action, label, scope.Current); err != nil {
					a.setAutomationFailure(r, err)
					return
				}
			}
			r.Status = "passed"
			return
		}
		action, resolveErr := core.ResolveAction(decision.Action, r.Values)
		if resolveErr != nil {
			a.setInterrupted(r, resolveErr)
			return
		}
		hash := automationStateFingerprint(action, public)
		if action.Operation != "assert" && action.Operation != "wait_for" && action.Operation != "switch_tab" && seen[hash] {
			a.setInterrupted(r, &BrowserError{Code: "needs_review", Message: "Identical action requested against unchanged evidence; no mutation was replayed"})
			return
		}
		seen[hash] = true
		if err = a.runAutomationAction(ctx, r, action, label, scope.Current); err != nil {
			a.setAutomationFailure(r, err)
			return
		}
		if err = scope.Advance(action); err != nil {
			a.setInterrupted(r, err)
			return
		}
	}
	a.setInterrupted(r, &BrowserError{Code: "blocked", Message: "Automation action budget exhausted before verified completion"})
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
	raw, _ := json.Marshal(struct {
		Action core.Action
		State  map[string]any
	}{action, state})
	return fmt.Sprintf("%x", sha256.Sum256(raw))
}
