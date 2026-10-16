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
		s.router.visual = false
		s.router.unchanged = -3 // allow DOM outcome checks after a visual handoff
		s.router.reads = 0
		s.rejections = 0
		s.domCooldown = 2
		s.event("agent_route", "dom")
		s.app.update(r)
		return agentharness.Outcome{Output: map[string]any{"status": "visual_handoff", "verificationRequired": true}}, nil
	case "blocked":
		return s.recoverGoal("visual_subtask_blocked", errors.New("Agent S could not advance this visual subtask. Inspect the DOM and try another approach to the original goal"), nil, true)
	case "click", "fill", "key":
	default:
		return s.recoverGoal("visual_intent_invalid", errors.New("Agent S returned an unsupported browser intent; no input was dispatched"), nil, true)
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
		if recoverableVisualDecision(ctx, err) {
			return s.recoverGoal("visual_target_rejected", err, &action, true)
		}
		return agentharness.Outcome{}, err
	}
	if err = core.ValidateAutomationAction(r.Plan, s.scope.Clone(), action); err != nil {
		return s.recoverGoal("visual_action_rejected", err, &action, true)
	}
	before := len(r.Steps)
	err = s.execute(ctx, automationDecision{Type: "action", Action: action})
	if err != nil {
		return agentharness.Outcome{}, err
	}
	if len(r.Steps) == before {
		return agentharness.Outcome{Output: s.lastRecovery}, nil
	}
	step := &r.Steps[len(r.Steps)-1]
	if step.Result != nil {
		step.Result["visualCapture"] = s.visualImage
	}
	s.app.update(r)
	if step.Status == "passed" {
		s.rejections, s.validation = 0, ""
	}
	return agentharness.Outcome{Output: map[string]any{"status": step.Status, "agent": "agent-s3", "step": recordedStepEvidence(*step), "verificationRequired": true}, Stop: r.Status != "running"}, nil
}
