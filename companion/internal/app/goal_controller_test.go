package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/native"
	"voiceqa/companion/internal/visualagent"
)

func goalTestSession(t *testing.T) *automationSession {
	a := newTestApp(t)
	r := &core.Run{ID: core.ID(), Status: "running", Usage: map[string]int{}, Plan: core.Plan{Origin: "https://app.test", URL: "https://app.test/", Request: "Finish the requested browser goal", Mode: "automation", Automation: &core.AutomationPolicy{Live: true, MaxActions: 30}}}
	scope, _ := core.NewScope(r.Plan, "main")
	return &automationSession{app: a, run: r, scope: scope, seen: map[string]bool{}, public: map[string]any{"url": r.Plan.URL}, observation: map[string]any{"url": r.Plan.URL}}
}

func TestVisualRejectionReturnsToGoalWithoutInput(t *testing.T) {
	s := goalTestSession(t)
	var err error = &visualagent.DecisionError{Message: "Invalid single action", Class: "ValueError"}
	if !recoverableVisualDecision(context.Background(), err) {
		t.Fatal("proposal error became fatal")
	}
	out, err := s.invokeRecovery(s.queueRecovery(err))
	if err != nil || out.Stop || s.run.Status != "running" || s.domCooldown != 2 || len(s.run.Steps) != 0 || s.lastRecovery["goal"] != s.run.Plan.Request {
		t.Fatal("goal lost or proposal replayed", out, err, s.run)
	}
	if recoverableVisualDecision(context.Background(), context.Canceled) || recoverableVisualDecision(context.Background(), &BrowserError{Code: "blocked", Message: "Origin changed"}) {
		t.Fatal("cancellation/scope failure treated as a format error")
	}
	if !recoverableVisualDecision(context.Background(), &BrowserError{Code: "visual_unavailable", Message: "Cropped screenshot; no input was dispatched"}) {
		t.Fatal("unavailable screenshots prevented a DOM recovery")
	}
}

func TestGoalRetriesOnlySafeUIOrConfirmedNonDispatch(t *testing.T) {
	s := goalTestSession(t)
	meta := map[string]any{"repeatableUI": true, "consequential": false, "opaque": false, "submissionKey": ""}
	s.app.Send = func(m native.Message) error {
		if m.Type == "browser.request" {
			s.app.Handle(message("browser.result", map[string]any{"requestId": m.ID, "result": meta}))
		}
		return nil
	}
	action := core.Action{Operation: "click", Target: "#tab", Label: "Open editor tab"}
	hash := automationStateFingerprint(action, s.public)
	s.seen[hash] = true
	if err := s.allowRepeatedUI(context.Background(), action); err != nil {
		t.Fatal(err)
	}
	meta["submissionKey"] = "already-submitted"
	if err := s.allowRepeatedUI(context.Background(), action); err == nil {
		t.Fatal("submission replay allowed")
	}
	meta["submissionKey"], meta["opaque"] = "", true
	if err := s.allowRepeatedUI(context.Background(), action); err == nil {
		t.Fatal("canvas replay allowed")
	}
	s.notDispatched = map[string]bool{hash: true}
	if err := s.allowRepeatedUI(context.Background(), action); err != nil {
		t.Fatal("confirmed non-dispatch cannot be retried", err)
	}
	s.uiRetries = map[string]int{hash: 2}
	if err := s.allowRepeatedUI(context.Background(), action); err == nil {
		t.Fatal("repeated UI has no bound")
	}
}

func TestGoalFinishesRemainingChecksWithoutErasingFailure(t *testing.T) {
	s := goalTestSession(t)
	s.app.Send = func(m native.Message) error {
		if m.Type != "browser.request" {
			return nil
		}
		var p map[string]any
		_ = json.Unmarshal(m.Payload, &p)
		reply := map[string]any{"requestId": m.ID, "result": map[string]any{"page": "main"}}
		if p["operation"] == "execute" && p["action"].(map[string]any)["target"] == "#wrong" {
			reply["code"], reply["error"] = "assertion_failed", "Expected 84, observed 99"
			reply["result"] = map[string]any{"actual": "99", "expected": "84", "passed": false}
		}
		s.app.Handle(message("browser.result", reply))
		return nil
	}
	d := automationDecision{Type: "action", Action: core.Action{Operation: "assert", Target: "#wrong", Assertion: &core.Assertion{Kind: "text", Expected: "84"}, Label: "Verify correct total"}}
	if err := s.execute(context.Background(), d); err != nil || s.run.Status != "running" {
		t.Fatal("check failed stopped remaining goal", err, s.run.Status)
	}
	completion := automationDecision{Type: "complete", Checks: []automationCheck{{Page: "main", Requirement: "Remaining outcome", Action: core.Action{Operation: "assert", Target: "#other", Assertion: &core.Assertion{Kind: "visible", Expected: "true"}, Label: "Remaining check"}}}}
	if err := s.execute(context.Background(), completion); err != nil {
		t.Fatal(err)
	}
	if s.run.Status != "failed" || len(s.run.Steps) != 2 || s.run.Steps[0].Status != "failed" || s.run.Steps[1].Status != "passed" {
		t.Fatal("failure hidden or remaining check dropped", s.run)
	}
	if _, err := s.recoverGoal("fixture", errors.New("bounded"), nil, false); err != nil {
		t.Fatal(err)
	}
}

func TestEditableContentRequiresValueBeforeRecordingAFailure(t *testing.T) {
	s := goalTestSession(t)
	s.app.Send = func(m native.Message) error {
		if m.Type == "browser.request" {
			s.app.Handle(message("browser.result", map[string]any{"requestId": m.ID, "result": map[string]any{"tag": "TEXTAREA", "text": "", "value": "wrong source"}}))
		}
		return nil
	}
	action := core.Action{Operation: "assert", Target: "#editor", Assertion: &core.Assertion{Kind: "text", Expected: "exact requested source"}}
	err := s.app.preflightAutomationAssertion(context.Background(), s.run, action)
	if err == nil || !strings.Contains(err.Error(), "kind=value") || len(s.run.Steps) != 0 {
		t.Fatal("wrong assertion source became a recorded application failure", err)
	}
	action.Assertion.Kind = "value"
	if err = s.app.preflightAutomationAssertion(context.Background(), s.run, action); err != nil || action.Assertion.Expected != "exact requested source" {
		t.Fatal("original expected content changed", err, action)
	}
}

func TestExactRequestedContentIsBoundBeforeInputWithoutUsingPageAsOracle(t *testing.T) {
	s := goalTestSession(t)
	source := "pragma solidity ^0.8.20; contract RouterProbe { uint public count = 7; }"
	formatted := "pragma solidity ^0.8.20;\ncontract RouterProbe {\nuint public count = 7;\n}"
	s.run.Plan.Request = "Put exactly this source in the editor: " + source + ". Then compile it."
	var dispatched string
	s.app.Send = func(m native.Message) error {
		if m.Type != "browser.request" {
			return nil
		}
		var p map[string]any
		_ = json.Unmarshal(m.Payload, &p)
		if p["operation"] == "execute" {
			dispatched, _ = p["action"].(map[string]any)["value"].(string)
		}
		s.app.Handle(message("browser.result", map[string]any{"requestId": m.ID, "result": map[string]any{}}))
		return nil
	}
	if err := s.execute(context.Background(), automationDecision{Type: "action", Action: core.Action{Operation: "fill", Target: "#editor", Value: formatted}}); err != nil || dispatched != source {
		t.Fatal("model formatting replaced the requested literal", dispatched, err)
	}
	action := core.Action{Operation: "assert", Target: "#editor", Assertion: &core.Assertion{Kind: "value", Expected: formatted}}
	if err := s.app.preflightAutomationAssertion(context.Background(), s.run, action); err == nil {
		t.Fatal("formatted output became its own expectation")
	}
	for _, request := range []string{"Generate a contract similar to " + source, s.run.Plan.Request + " Again: " + source} {
		if value, ok := requestedExactContent(request, formatted); ok {
			t.Fatal("generated/ambiguous content was rewritten", value)
		}
	}
}
