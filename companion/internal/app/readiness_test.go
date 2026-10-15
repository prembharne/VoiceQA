package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/native"
)

func TestReadinessTimeoutRecoveryIsBoundedAndPreservesEvidence(t *testing.T) {
	a := newTestApp(t)
	dispatches := 0
	replyCode := "wait_timeout"
	a.Send = func(m native.Message) error {
		if m.Type != "browser.request" {
			return nil
		}
		var p map[string]any
		_ = json.Unmarshal(m.Payload, &p)
		reply := map[string]any{"requestId": m.ID, "result": map[string]any{}}
		if p["operation"] == "execute" {
			dispatches++
			reply["code"], reply["error"] = replyCode, "Readiness requires fresh inspection"
			reply["result"] = map[string]any{"actual": "target missing", "pending": true, "waitedMs": 1000, "timeoutMs": 1000}
		}
		a.Handle(message("browser.result", reply))
		return nil
	}
	r := &core.Run{ID: "slow-compile", Status: "running", Plan: core.Plan{URL: "https://app.test/", Origin: "https://app.test", Mode: "automation", Automation: &core.AutomationPolicy{Live: true, MaxActions: 20}}}
	scope, _ := core.NewScope(r.Plan, "main")
	s := &automationSession{app: a, run: r, scope: scope, seen: map[string]bool{}, public: map[string]any{"url": r.Plan.URL}}
	action := core.Action{Operation: "wait_for", Target: "#compile", Label: "Await compile", TimeoutMS: 1000, Assertion: &core.Assertion{Kind: "enabled", Expected: "true"}}
	d := automationDecision{Type: "action", Action: action}
	if err := s.execute(context.Background(), d); err != nil || r.Status != "running" || s.waitRecoveries != 1 {
		t.Fatal("inconclusive wait prematurely ended run", err, r.Status)
	}
	if r.Steps[0].Status != "wait_timeout" || r.Steps[0].Result["pending"] != true {
		t.Fatal("timeout evidence erased", r.Steps)
	}
	if err := s.validate(context.Background(), &d); err == nil || !strings.Contains(err.Error(), "already returned inconclusive") {
		t.Fatal("unchanged timeout can be repeated", err)
	}
	// A genuinely different freshly inspected condition is allowed, but never
	// more than two autonomous recovery turns for the whole run.
	for _, target := range []string{"#job-status", "#artifact"} {
		if target == "#job-status" {
			replyCode = "wait_changed"
		} else {
			replyCode = "wait_timeout"
		}
		d.Action.Target = target
		if err := s.execute(context.Background(), d); err != nil {
			t.Fatal(err)
		}
	}
	if r.Status != "needs_review" || dispatches != 3 || s.waitRecoveries != 2 {
		t.Fatal("readiness recovery is unbounded", r.Status, dispatches, s.waitRecoveries)
	}
	for _, step := range r.Steps {
		if step.Action.Operation != "wait_for" || (step.Status != "wait_timeout" && step.Status != "wait_changed") || step.Action.Assertion.Expected != "true" {
			t.Fatal("mutation/expectation/verdict rewritten", step)
		}
	}
	evidence := recordedStepEvidence(r.Steps[0])["result"].(map[string]any)
	if evidence["pending"] != true || evidence["waitedMs"] == nil {
		t.Fatal("AI feedback lost timing evidence", evidence)
	}
	if diagnose(r).Category != "readiness_timeout" {
		t.Fatal("timeout mislabeled as an application defect", diagnose(r))
	}
	r.Steps = append(r.Steps, core.Step{ID: "real-failure", Status: "failed", Action: core.Action{Operation: "assert"}, Result: map[string]any{"actual": "wrong"}})
	r.Status = "failed"
	if diagnose(r).StepID != "real-failure" {
		t.Fatal("earlier readiness timeout hid the measured defect", diagnose(r))
	}
}
