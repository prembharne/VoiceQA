package app

import (
	"context"
	"errors"
	"fmt"
	"voiceqa/companion/internal/core"
)

func (s *automationSession) validate(ctx context.Context, decision *automationDecision) error {
	a, r, scope, obs, public := s.app, s.run, s.scope, s.observation, s.public
	var e error
	if e == nil && decision.Type != "tool" && (decision.Name != "" || decision.Args != (agentArgs{})) {
		e = errors.New("Read-tool fields cannot be mixed with an action or completion")
	}
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
					r.AgentPhase = "Checking selected control"
					a.update(r)
					if r.Status == "error" {
						return errors.New(r.Error)
					}
					meta, e = a.browser(ctx, r.ID, "", map[string]any{"operation": "resolve_target", "target": decision.Action.Target, "origin": r.Plan.Origin})
					if e == nil {
						e = validateResolvedAutomationControl(decision.Action, meta)
					}
					if e == nil && decision.Action.Operation == "click" && meta["submissionAlreadyDispatched"] == true {
						e = errors.New("Unchanged form inputs were already submitted. Do not click submit again; inspect the actual result or advance to the next requested page")
					}
					if e == nil && decision.Action.Operation == "click" {
						e = validateAutomationSubmission(meta)
					}
					if e != nil {
						e = fmt.Errorf("The proposed control is not currently actionable. Do not guess a later-stage field. Use the actual current controls and advance this stage first. Details: %w", e)
					}
				}
			}
		}
		if e == nil && decision.Action.Operation == "key" && (decision.Action.Value == "Enter" || decision.Action.Value == "Space") {
			meta, err := a.browser(ctx, r.ID, "", map[string]any{"operation": "action_context", "target": decision.Action.Target, "key": decision.Action.Value, "origin": r.Plan.Origin})
			e = err
			if e == nil {
				e = validateAutomationSubmission(meta)
			}
			if e == nil && meta["submissionAlreadyDispatched"] == true {
				e = errors.New("Unchanged form inputs were already submitted; inspect the actual result instead of pressing submit again")
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
				return e
			}
		}
	} else if e == nil && decision.Type == "tool" {
		e = validateAutomationRead(r.Plan, scope.Current, *decision, s.readCalls)
		if e == nil && s.readSeen[automationReadFingerprint(*decision, public, len(r.Steps))] {
			e = errors.New("This read was already attempted against unchanged evidence. Use its recorded toolResult/toolError, choose another read or advance the workflow")
		}
	} else if e == nil && decision.Type != "blocked" {
		e = errors.New("choose one action, a live read tool, complete or blocked")
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
	if e == nil && decision.Type == "action" && automationReplayBlocked(decision.Action, public, s.seen) {
		e = errors.New("This identical action was already dispatched against unchanged evidence; it will not be replayed. Inspect current controls and choose a different next action, verify the actual outcome, or report the blocker. A successful dispatch is not proof of progress")
	}
	if e == nil && decision.Type == "action" && decision.Action.Operation == "wait_for" && s.pendingWaits[automationStateFingerprint(decision.Action, public)] {
		e = errors.New("This readiness condition already returned inconclusive evidence against unchanged state. Inspect the current status and stable result target, verify a newly observed outcome without changing its expectation, or report the blocker. Do not repeat the wait or the preceding mutation")
	}
	return e
}

func (s *automationSession) execute(ctx context.Context, decision automationDecision) error {
	a, r, scope, public, label := s.app, s.run, s.scope, s.public, s.viewport
	var err error
	r.AgentPhase = ""
	if decision.Type == "tool" {
		s.readSeen[automationReadFingerprint(decision, public, len(r.Steps))] = true
		s.readCalls++
		r.AgentPhase = "Inspecting current page: " + decision.Name
		a.update(r)
		if r.Status == "error" {
			return nil
		}
		result, readErr := a.browser(ctx, r.ID, "", map[string]any{"operation": "automation_tool", "tool": decision.Name, "page": scope.Current, "target": decision.Args.Target, "query": decision.Args.Query, "origin": r.Plan.Origin})
		if ctx.Err() != nil {
			a.setInterrupted(r, ctx.Err())
			return nil
		}
		evidence := map[string]any{"url": public["url"], "page": scope.Current, "tool": decision.Name, "arguments": decision.Args}
		if readErr != nil {
			evidence["toolError"] = recordedText(readErr.Error(), 1200)
		} else {
			evidence["toolResult"] = agentPublicEvidence(result)
		}
		rememberAutomationRead(r, evidence)
		a.update(r)
		if r.Status == "error" {
			return nil
		}
		return nil
	}
	if decision.Type == "blocked" {
		a.setInterrupted(r, &BrowserError{Code: "blocked", Message: decision.Message})
		return nil
	}
	if decision.Type == "complete" {
		if len(r.Steps)+automationCompletionCost(scope.Current, decision.Checks) > r.Plan.Automation.MaxActions {
			a.setInterrupted(r, &BrowserError{Code: "blocked", Message: "Not enough action budget remains for every success criterion"})
			return nil
		}
		for _, check := range decision.Checks {
			if check.Page != scope.Current {
				switchAction := core.Action{Operation: "switch_tab", Target: check.Page, Label: "Switch to " + check.Page + " for outcome verification"}
				if err = core.ValidateAutomationAction(r.Plan, scope.Clone(), switchAction); err != nil {
					a.setInterrupted(r, err)
					return nil
				}
				if err = a.runAutomationAction(ctx, r, switchAction, label, scope.Current); err != nil {
					a.setAutomationFailure(r, err)
					return nil
				}
				if err = scope.Advance(switchAction); err != nil {
					a.setInterrupted(r, err)
					return nil
				}
			}
			fresh, observeErr := a.browser(ctx, r.ID, "", map[string]any{"operation": "observe", "origin": r.Plan.Origin})
			if observeErr != nil {
				a.setInterrupted(r, observeErr)
				return nil
			}
			if page, ok := fresh["page"].(string); ok && page != "" && page != check.Page {
				a.setInterrupted(r, &BrowserError{Code: "needs_review", Message: "Verification page changed before its fresh observation"})
				return nil
			}
			rememberAutomationObservation(r, agentPublicEvidence(fresh))
			one := []automationCheck{check}
			normalizeAutomationCheckTargets(one, fresh)
			check = one[0]
			if err = a.preflightAutomationAssertion(ctx, r, check.Action); err != nil {
				a.setAutomationFailure(r, err)
				return nil
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
				return nil
			}
		}
		r.Status = "passed"
		return nil
	}
	action, resolveErr := core.ResolveAction(decision.Action, r.Values)
	if resolveErr != nil {
		a.setInterrupted(r, resolveErr)
		return nil
	}
	hash := automationStateFingerprint(action, public)
	if automationReplayBlocked(action, public, s.seen) {
		a.setInterrupted(r, &BrowserError{Code: "needs_review", Message: "Identical action requested against unchanged evidence; no mutation was replayed"})
		return nil
	}
	s.seen[hash] = true
	if err = a.runAutomationAction(ctx, r, action, label, scope.Current); err != nil {
		var browser *BrowserError
		if action.Operation == "wait_for" && errors.As(err, &browser) && (browser.Code == "wait_timeout" || browser.Code == "wait_changed") && s.waitRecoveries < 2 {
			// A changed status/read deadline does not establish an application
			// defect. Keep the original inconclusive step and re-observe before the next AI
			// decision. No mutation, expectation or previous verdict is retried.
			s.waitRecoveries++
			if s.pendingWaits == nil {
				s.pendingWaits = map[string]bool{}
			}
			s.pendingWaits[hash] = true
			s.router.unchanged, s.router.reads = -1, 0
			event := "readiness_timeout"
			if browser.Code == "wait_changed" {
				event = "readiness_changed"
			}
			s.event(event, action.Target)
			return nil
		}
		a.setAutomationFailure(r, err)
		return nil
	}
	if err = scope.Advance(action); err != nil {
		a.setInterrupted(r, err)
		return nil
	}
	return nil
}
