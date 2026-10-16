package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"voiceqa/companion/internal/agentharness"
	"voiceqa/companion/internal/core"
)

const recoveryTool = "voiceqa_goal_recovery"

// Recover a rejected proposal, never replay it. A fresh observation and this
// feedback inform the next model decision; the original request stays the goal.
func (s *automationSession) recoverGoal(source string, err error, action *core.Action, dom bool) (agentharness.Outcome, error) {
	r := s.run
	limit := max(8, min(24, r.Plan.Automation.MaxActions))
	if s.recoveryStreak >= limit || s.recoveries >= max(limit, min(160, 2*r.Plan.Automation.MaxActions)) {
		return agentharness.Outcome{}, &BrowserError{Code: "blocked", Message: fmt.Sprintf("The goal remains unverified after %d recovery attempts since the last verified progress (%d total). Completed evidence is retained; no ambiguous submission was replayed", s.recoveryStreak, s.recoveries)}
	}
	s.recoveries++
	s.recoveryStreak++
	s.validation = recordedText(err.Error(), 1400)
	feedback := map[string]any{"status": "recovering", "source": source, "reason": s.validation, "goal": r.Plan.Request, "attempt": s.recoveries, "remainingRecoveries": limit - s.recoveryStreak, "guidance": "Re-observe actual state. Preserve verifiedProgress and continue the unfinished goal instead of restarting completed stages. Do not infer success from dispatch, repeat a consequential/uncertain submission, or change expected outcomes to hide a defect."}
	if action != nil {
		feedback["proposal"] = recordedStepEvidence(core.Step{Action: *action})["action"]
	}
	s.lastRecovery = feedback
	s.event("goal_recovery", source)["feedback"] = feedback
	r.AgentPhase = "Recovering and checking the current state"
	if dom {
		s.router.visual, s.router.unchanged, s.router.reads, s.router.visualTurns = false, -2, 0, 0
		s.domCooldown, s.rejections = 2, 0
		s.event("agent_route", "dom")
	}
	s.app.update(r)
	if r.Status == "error" {
		return agentharness.Outcome{}, errors.New(r.Error)
	}
	return agentharness.Outcome{Output: feedback}, nil
}

func (s *automationSession) queueRecovery(err error) agentharness.Call {
	return s.queueRecoveryFrom("visual_decision_rejected", err)
}
func (s *automationSession) queueRecoveryFrom(source string, err error) agentharness.Call {
	s.recoveryTicket = core.ID()
	s.pendingRecoverySource = source
	s.pendingRecovery = recordedText(err.Error(), 1400)
	args, _ := json.Marshal(map[string]string{"ticket": s.recoveryTicket})
	return agentharness.Call{Name: recoveryTool, Arguments: string(args)}
}

func (s *automationSession) invokeRecovery(call agentharness.Call) (agentharness.Outcome, error) {
	var p struct {
		Ticket string `json:"ticket"`
	}
	if json.Unmarshal([]byte(call.Arguments), &p) != nil || p.Ticket == "" || p.Ticket != s.recoveryTicket {
		return agentharness.Outcome{}, errors.New("Goal recovery ticket expired")
	}
	s.recoveryTicket = ""
	return s.recoverGoal(s.pendingRecoverySource, errors.New(s.pendingRecovery), nil, true)
}

func recoverableVisualDecision(ctx context.Context, err error) bool {
	if err == nil || ctx.Err() != nil || errors.Is(err, context.Canceled) {
		return false
	}
	var be *BrowserError
	if errors.As(err, &be) && be.Code != "target_missing" && be.Code != "needs_review" && be.Code != "visual_unavailable" {
		return false
	}
	for _, status := range []string{"HTTP 401", "HTTP 402", "HTTP 403"} {
		if strings.Contains(err.Error(), status) {
			return false
		}
	}
	return true // This proposal/capture stage never dispatches browser input.
}

func automationHasFailures(r *core.Run) bool {
	for _, step := range r.Steps {
		if step.Status == "failed" {
			return true
		}
	}
	return false
}

func (s *automationSession) allowRepeatedUI(ctx context.Context, action core.Action) error {
	if !automationReplayBlocked(action, s.public, s.seen) {
		return nil
	}
	hash := automationStateFingerprint(action, s.public)
	if s.notDispatched[hash] && s.uiRetries[hash] < 2 {
		return nil
	}
	if action.Operation == "click" && s.uiRetries[hash] < 2 {
		meta, err := s.app.browser(ctx, s.run.ID, "", map[string]any{"operation": "action_context", "target": action.Target, "origin": s.run.Plan.Origin})
		if err != nil {
			return err
		}
		if meta["repeatableUI"] == true && meta["consequential"] == false && meta["opaque"] == false && stringField(meta, "submissionKey") == "" {
			return nil // Only a currently identified tab/tree/menu control.
		}
	}
	return errors.New("This action already ran against unchanged evidence; it will not be replayed. Inspect its actual result or choose a different approach. Only confirmed non-dispatches and identified non-submitting UI navigation controls can be retried; no uncertain or consequential submission was repeated")
}
