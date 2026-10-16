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
		if s.remainingReads() == 0 {
			return errors.New("Read tools are unavailable until new verified progress, or the total discovery budget is exhausted. Use existing evidence and supported actions; do not request another disabled read.")
		}
		e = validateAutomationRead(r.Plan, scope.Current, *decision, s.stageReads)
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
		e = s.allowRepeatedUI(ctx, decision.Action)
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
		s.stageReads++
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
		if s.blockerReports < 2 {
			s.blockerReports++
			_, err = s.recoverGoal("agent_reported_blocker", errors.New(decision.Message), nil, false)
			return err
		}
		if automationHasFailures(r) {
			r.Status = "failed"
			r.Error = "The goal remains incomplete with recorded failed checks: " + recordedText(decision.Message, 1400)
		} else {
			a.setInterrupted(r, &BrowserError{Code: "blocked", Message: decision.Message})
		}
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
				var be *BrowserError
				if errors.As(err, &be) && be.Code == "assertion_failed" {
					continue
				}
				a.setAutomationFailure(r, err)
				return nil
			}
			s.checkpoint(r.Steps[len(r.Steps)-1])
		}
		r.Status = "passed"
		if automationHasFailures(r) {
			r.Status = "failed"
			r.Error = "The goal's checks completed with recorded discrepancies. Earlier failed checks remain failed."
		}
		return nil
	}
	action, resolveErr := core.ResolveAction(decision.Action, r.Values)
	if resolveErr != nil {
		a.setInterrupted(r, resolveErr)
		return nil
	}
	if action.Operation == "fill" {
		if literal, ok := requestedExactContent(r.Plan.Request, action.Value); ok {
			action.Value = literal
			if err = core.ValidateAutomationAction(r.Plan, scope.Clone(), action); err != nil {
				_, err = s.recoverGoal("literal_input_rejected", err, &action, action.Visual != nil)
				return err
			}
			s.event("literal_input_preserved", action.Target)
		}
	}
	hash := automationStateFingerprint(action, public)
	if automationReplayBlocked(action, public, s.seen) {
		if err = s.allowRepeatedUI(ctx, action); err != nil {
			_, err = s.recoverGoal("repeat_rejected", err, &action, action.Visual != nil)
			return err
		}
		if s.uiRetries == nil {
			s.uiRetries = map[string]int{}
		}
		s.uiRetries[hash]++
		s.event("ui_navigation_retry", action.Target)
	}
	delete(s.notDispatched, hash)
	s.seen[hash] = true
	before := len(r.Steps)
	if err = a.runAutomationAction(ctx, r, action, label, scope.Current); err != nil {
		if ctx.Err() != nil || r.Status != "running" {
			a.setAutomationFailure(r, err)
			return nil
		}
		var browser *BrowserError
		if action.Operation == "wait_for" && errors.As(err, &browser) && (browser.Code == "wait_timeout" || browser.Code == "wait_changed") {
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
			_, err = s.recoverGoal(event, err, &action, false)
			return err
		}
		if errors.As(err, &browser) && browser.Code == "assertion_failed" {
			s.event("goal_check_failed", action.Target)
			_, err = s.recoverGoal("check_failed", err, &action, false)
			return err
		}
		var last map[string]any
		if len(r.Steps) > before {
			last = r.Steps[len(r.Steps)-1].Result
		}
		if errors.As(err, &browser) && browser.Code != "cancelled" && last["inputState"] == "not_dispatched" {
			if s.notDispatched == nil {
				s.notDispatched = map[string]bool{}
			}
			s.notDispatched[hash] = true
			_, err = s.recoverGoal("browser_input_not_dispatched", err, &action, action.Visual != nil)
			return err
		}
		a.setAutomationFailure(r, err)
		return nil
	}
	if err = scope.Advance(action); err != nil {
		a.setInterrupted(r, err)
		return nil
	}
	s.checkpoint(r.Steps[len(r.Steps)-1])
	return nil
}
