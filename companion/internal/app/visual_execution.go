package app

import (
	"context"
	"encoding/json"
	"errors"
	"voiceqa/companion/internal/agentharness"
	"voiceqa/companion/internal/core"
)

func (s *automationSession) invokeVisual(ctx context.Context, call agentharness.Call) (agentharness.Outcome, error) {
	var ticket struct {
		Ticket string `json:"ticket"`
	}
	if json.Unmarshal([]byte(call.Arguments), &ticket) != nil || ticket.Ticket == "" || ticket.Ticket != s.visualTicket {
		return agentharness.Outcome{}, errors.New("Visual decision ticket expired")
	}
	s.visualTicket = ""
	intent, r := s.visualReply.Result, s.run
	s.router.visualTurns++
	switch intent.Operation {
	case "done", "report", "inspect":
		rememberAutomationRead(r, map[string]any{"tool": "agent_s_visual", "page": s.scope.Current, "toolResult": map[string]any{"observation": intent.Text, "intent": intent.Operation, "capture": s.visualImage, "agent": "agent-s3", "model": fallbackModel, "limitation": "Visual interpretation is not an assertion or proof of task completion"}})
		if intent.Operation == "done" {
			s.router.visual = false
			s.router.unchanged = -3 // allow DOM outcome checks after a visual handoff
			s.router.reads = 0
			s.rejections = 0
			s.event("agent_route", "dom")
		}
		s.app.update(r)
		return agentharness.Outcome{Output: map[string]any{"status": "visual_handoff", "verificationRequired": true}}, nil
	case "blocked":
		return agentharness.Outcome{}, &BrowserError{Code: "blocked", Message: "Agent S could not safely advance the visual subtask"}
	case "click", "fill", "key":
	default:
		return agentharness.Outcome{}, errors.New("Agent S returned an unsupported browser intent")
	}
	point := visualPoint(s.visualReply, s.visualImage)
	if intent.Operation == "key" {
		// Keyboard decisions have no grounded point, but remain bound to the full
		// fresh viewport and current focus from this same screenshot.
		point.Width = visualInt(s.visualImage["width"])
		point.Height = visualInt(s.visualImage["height"])
	}
	action := core.Action{Operation: intent.Operation, Value: intent.Value, Label: "Agent S: " + intent.Description}
	action.Label = recordedText(action.Label, 290)
	for len(action.Label) > 295 {
		runes := []rune(action.Label)
		action.Label = string(runes[:len(runes)-1])
	}
	if action.Label == "Agent S: " {
		action.Label = "Agent S: press " + intent.Value
	}
	action, err := s.app.resolveVisualAction(ctx, r, action, point)
	if err != nil {
		var be *BrowserError
		if errors.As(err, &be) && be.Code == "target_missing" {
			s.validation = "Visual observation became stale before dispatch; take a new screenshot"
			return agentharness.Outcome{Output: map[string]string{"status": "not_dispatched", "reason": s.validation}}, nil
		}
		return agentharness.Outcome{}, err
	}
	if err = core.ValidateAutomationAction(r.Plan, s.scope.Clone(), action); err != nil {
		return agentharness.Outcome{}, err
	}
	if automationReplayBlocked(action, s.public, s.seen) {
		return agentharness.Outcome{}, &BrowserError{Code: "needs_review", Message: "Agent S requested the same action against unchanged evidence; it was not replayed"}
	}
	s.seen[automationStateFingerprint(action, s.public)] = true
	err = s.app.runAutomationAction(ctx, r, action, s.viewport, s.scope.Current)
	if err != nil {
		return agentharness.Outcome{}, err
	}
	r.Steps[len(r.Steps)-1].Result["visualCapture"] = s.visualImage
	s.app.update(r)
	s.rejections, s.validation = 0, ""
	return agentharness.Outcome{Output: map[string]any{"status": "executed", "agent": "agent-s3", "step": recordedStepEvidence(r.Steps[len(r.Steps)-1]), "verificationRequired": true}}, nil
}
