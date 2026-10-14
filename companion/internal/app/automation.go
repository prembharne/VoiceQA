package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
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
	raw, usage, err := a.aiClient(s.AIProvider).PlanStructured(ctx, a.keyFor(s.AIProvider), s.Model, provider.AutomationProposalInstructions, map[string]any{"request": p.Request, "observation": agentPublicEvidence(obs), "conversation": p.Conversation, "permissions": map[string]any{"allowConsequential": p.AllowConsequential, "apiWritesAllowed": p.APIWritesAllowed, "maxActions": p.MaxActions}, "sharedPages": agentPublicEvidence(map[string]any{"pages": p.Pages})["pages"]}, provider.AutomationProposalSchema(), func(pr provider.PlanProgress) {
		_ = a.emit("plan.progress", map[string]any{"requestId": m.ID, "phase": pr.Phase, "receivedChars": pr.ReceivedChars}, "", "")
	})
	if err != nil {
		return nil, planningError(err)
	}
	var draft struct {
		Summary  string   `json:"summary"`
		Criteria []string `json:"criteria"`
		Question string   `json:"question"`
	}
	if err = json.Unmarshal(raw, &draft); err != nil {
		return nil, err
	}
	plan := core.Plan{ID: core.ID(), Version: 1, Request: p.Request, URL: p.URL, Origin: p.Origin, Pages: p.Pages, Mode: "automation", PreserveViewport: true, Viewports: []core.Viewport{observedViewport(obs)}, Summary: draft.Summary, Clarification: draft.Question, AIProvider: s.AIProvider, Model: s.Model, CreatedAt: core.Now(), Usage: usage, Cases: []core.Case{}, APIWritesAllowed: p.APIWritesAllowed, Automation: &core.AutomationPolicy{MaxActions: p.MaxActions, AllowConsequential: p.AllowConsequential, Criteria: draft.Criteria}}
	if plan.Clarification == "" {
		if err = core.ValidatePlan(plan); err != nil {
			input := map[string]any{"request": p.Request, "observation": agentPublicEvidence(obs), "previousProposal": draft, "validationError": err.Error(), "rule": "Replace interaction instructions with final-state outcome criteria. Preserve the complete requested goal."}
			fixed, extraUsage, fixErr := a.aiClient(s.AIProvider).PlanStructured(ctx, a.keyFor(s.AIProvider), s.Model, provider.AutomationProposalInstructions, input, provider.AutomationProposalSchema(), nil)
			if plan.Usage == nil {
				plan.Usage = map[string]int{}
			}
			for key, n := range extraUsage {
				plan.Usage[key] += n
			}
			if fixErr != nil {
				return nil, fixErr
			}
			if fixErr = json.Unmarshal(fixed, &draft); fixErr != nil {
				return nil, fixErr
			}
			plan.Summary = draft.Summary
			plan.Clarification = draft.Question
			plan.Automation.Criteria = draft.Criteria
			if draft.Question == "" {
				if err = core.ValidatePlan(plan); err != nil {
					return nil, err
				}
			}
		}
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	return plan, a.Store.Put("plan", plan.ID, plan)
}

type automationCheck struct {
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
		for attempt := 0; attempt < 2; attempt++ {
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
			raw, usage, e := a.aiClient(r.Plan.AIProvider).PlanStructured(ctx, a.keyFor(r.Plan.AIProvider), r.Plan.Model, provider.AutomationInstructions, map[string]any{"goal": r.Plan.Request, "successCriteria": r.Plan.Automation.Criteria, "permissions": r.Plan.Automation, "apiWritesAllowed": r.Plan.APIWritesAllowed, "scope": scope, "observation": public, "observedStateHistory": r.Observations, "earlierEvidenceOmitted": r.EvidenceOmitted, "recentSteps": agentPublicEvidence(map[string]any{"steps": history})["steps"], "publicValues": r.Values, "credentialProfiles": allowedProfiles, "remainingActions": r.Plan.Automation.MaxActions - len(r.Steps), "validationError": validation}, schema, nil)
			for key, n := range usage {
				r.Usage[key] += n
			}
			if e != nil {
				a.setInterrupted(r, planningError(e))
				return
			}
			var packet struct {
				Result automationDecision `json:"result"`
			}
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.DisallowUnknownFields()
			e = decoder.Decode(&packet)
			decision = packet.Result
			if e == nil && decision.Type == "action" {
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
							_, e = a.browser(ctx, r.ID, "", map[string]any{"operation": "resolve_target", "target": decision.Action.Target, "origin": r.Plan.Origin})
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
					normalizeAutomationCheckTargets(decision.Checks, obs)
					e = validateAutomationCompletion(r.Plan, scope, decision.Checks)
				}
			} else if e == nil && decision.Type != "blocked" {
				e = errors.New("choose action, complete or blocked")
			}
			if e == nil && decision.Type == "action" && decision.Action.Operation == "assert" {
				e = a.preflightAutomationAssertion(ctx, r, decision.Action)
			}
			if e == nil && decision.Type == "complete" {
				for _, check := range decision.Checks {
					if e = a.preflightAutomationAssertion(ctx, r, check.Action); e != nil {
						break
					}
				}
			}
			if e == nil {
				break
			}
			validation = e.Error()
			if attempt == 1 {
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
			if len(r.Steps)+len(decision.Checks) > r.Plan.Automation.MaxActions {
				a.setInterrupted(r, &BrowserError{Code: "blocked", Message: "Not enough action budget remains for every success criterion"})
				return
			}
			for _, check := range decision.Checks {
				criterionLabel := []rune(r.Plan.Automation.Criteria[check.CriterionID-1])
				if len(criterionLabel) > 180 {
					criterionLabel = append(criterionLabel[:180], '…')
				}
				check.Action.Label = fmt.Sprintf("Verify criterion %d: %s", check.CriterionID, string(criterionLabel))
				if err = a.runAutomationAction(ctx, r, check.Action, label); err != nil {
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
		if action.Operation != "assert" && action.Operation != "wait_for" && seen[hash] {
			a.setInterrupted(r, &BrowserError{Code: "needs_review", Message: "Identical action requested against unchanged evidence; no mutation was replayed"})
			return
		}
		seen[hash] = true
		if err = a.runAutomationAction(ctx, r, action, label); err != nil {
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
	r.Observations = append(r.Observations, map[string]any{"id": fmt.Sprintf("O%d", len(r.Steps)), "afterActions": len(r.Steps), "evidence": snapshot})
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
	if len(checks) != len(plan.Automation.Criteria) {
		return errors.New("completion must independently verify every approved success criterion")
	}
	seen := map[int]bool{}
	for _, check := range checks {
		if check.CriterionID < 1 || check.CriterionID > len(plan.Automation.Criteria) || seen[check.CriterionID] || check.Action.Operation != "assert" {
			return errors.New("completion requires one unique assert per approved criterion")
		}
		seen[check.CriterionID] = true
		if err := core.ValidateAutomationAction(plan, scope.Clone(), check.Action); err != nil {
			return err
		}
	}
	return nil
}
func (a *App) runAutomationAction(ctx context.Context, r *core.Run, action core.Action, viewport string) error {
	idx, err := a.beginStep(ctx, r, action, "Adaptive browser automation", viewport)
	if err != nil {
		return err
	}
	result, err := a.executeAdvanced(ctx, r, idx, action)
	r.Steps[idx].CompletedAt = core.Now()
	r.Steps[idx].Result = result
	r.Steps[idx].Status = "passed"
	r.Steps[idx].Page, _ = result["page"].(string)
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
		currentMatches := false
		candidates := []string{}
		for _, raw := range results {
			row, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			target, _ := row["target"].(string)
			text, _ := row["text"].(string)
			if target == a.Target && matches(text) {
				currentMatches = true
			}
			if target != "" && matches(text) {
				candidates = append(candidates, target)
			}
		}
		if !currentMatches && len(candidates) == 1 {
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
