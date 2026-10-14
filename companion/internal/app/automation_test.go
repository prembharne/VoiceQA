package app

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/native"
)

func TestAutomationCompletionCannotSkipCriteriaOrUseMutationAsProof(t *testing.T) {
	p := core.Plan{Mode: "automation", URL: "https://app.test/", Origin: "https://app.test", Automation: &core.AutomationPolicy{MaxActions: 20, Criteria: []string{"Requested data is confirmed", "Exactly one reservation exists"}}}
	scope, _ := core.NewScope(p, "main")
	check := automationCheck{CriterionID: 1, Action: core.Action{Operation: "assert", Target: "#receipt", Assertion: &core.Assertion{Kind: "text_contains", Expected: "Confirmed"}}}
	if validateAutomationCompletion(p, scope, []automationCheck{check}) == nil {
		t.Fatal("missing criterion accepted")
	}
	if validateAutomationCompletion(p, scope, []automationCheck{check, check}) == nil {
		t.Fatal("duplicate criterion accepted")
	}
	other := automationCheck{CriterionID: 2, Action: core.Action{Operation: "click", Target: "#submit"}}
	if validateAutomationCompletion(p, scope, []automationCheck{check, other}) == nil {
		t.Fatal("mutation accepted as completion evidence")
	}
	other.Action = core.Action{Operation: "assert", Target: "#count", Assertion: &core.Assertion{Kind: "number", Expected: "1"}}
	if err := validateAutomationCompletion(p, scope, []automationCheck{check, other}); err != nil {
		t.Fatal(err)
	}
}

func TestLiveCompletionRequiresOutcomeAssertionsInsteadOfActionPlans(t *testing.T) {
	p := core.Plan{Mode: "automation", URL: "https://app.test/", Origin: "https://app.test", Automation: &core.AutomationPolicy{Live: true, MaxActions: 20}}
	scope, _ := core.NewScope(p, "main")
	check := automationCheck{Requirement: "Requested record was saved", Action: core.Action{Operation: "assert", Target: "#status", Assertion: &core.Assertion{Kind: "text_contains", Expected: "Saved"}}}
	if err := validateAutomationCompletion(p, scope, []automationCheck{check}); err != nil {
		t.Fatal(err)
	}
	if validateAutomationCompletion(p, scope, nil) == nil || validateAutomationCompletion(p, scope, []automationCheck{check, check}) == nil {
		t.Fatal("missing/duplicate outcomes accepted")
	}
	check.Action.Operation = "click"
	if validateAutomationCompletion(p, scope, []automationCheck{check}) == nil {
		t.Fatal("mutation used as completion proof")
	}
}

func TestLiveRequestPreparationDoesNotCallAIOrGenerateAPlan(t *testing.T) {
	a := newTestApp(t)
	a.Send = func(m native.Message) error {
		if m.Type == "browser.request" {
			a.Handle(message("browser.result", map[string]any{"requestId": m.ID, "result": map[string]any{"viewport": map[string]any{"width": 1280, "height": 720}}}))
		}
		return nil
	}
	raw, err := a.proposeAutomation(context.Background(), message("automation.propose", map[string]any{"request": "Save the requested setting using the current page", "url": "https://app.test/", "origin": "https://app.test"}))
	if err != nil {
		t.Fatal(err)
	}
	p := raw.(core.Plan)
	if !p.Automation.Live || len(p.Cases) != 0 || len(p.Automation.Criteria) != 0 || len(p.Usage) != 0 {
		t.Fatal("local preparation generated a plan or used AI", p)
	}
}

func TestLiveDecisionTimeoutDoesNotClaimNoActionsRan(t *testing.T) {
	err := agentResponseError(context.DeadlineExceeded, "next tool decision", true)
	if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "completed actions remain") || strings.Contains(err.Error(), "No tests were run") || strings.Contains(err.Error(), "building the plan") {
		t.Fatal("live timeout lost partial-action meaning or cancellation identity", err)
	}
}

func TestAutomationStopsBeforeObservingWhenEvidenceStoreFails(t *testing.T) {
	a := newTestApp(t)
	observations := 0
	a.Send = func(m native.Message) error {
		if m.Type == "browser.request" {
			var payload map[string]any
			_ = json.Unmarshal(m.Payload, &payload)
			if payload["operation"] != "cleanup" {
				observations++
			}
			a.Handle(message("browser.result", map[string]any{"requestId": m.ID, "result": map[string]any{}}))
		}
		return nil
	}
	_ = a.Store.Close()
	r := core.Run{ID: "closed-store-run", Status: "running", Plan: core.Plan{Mode: "automation", URL: "https://app.test/", Origin: "https://app.test", Automation: &core.AutomationPolicy{MaxActions: 20, Criteria: []string{"Reservation confirmed"}}}}
	a.executeAutomation(context.Background(), &r)
	if observations != 0 || r.Status != "error" || !strings.Contains(r.Error, "persist run state") {
		t.Fatal("automation continued without durable evidence", observations, r.Status, r.Error)
	}
}

func TestAutomationReplayFingerprintIgnoresLabelsButTracksActualState(t *testing.T) {
	action := core.Action{Operation: "click", Target: "#submit", Label: "Submit once"}
	state := map[string]any{"text": "Ready"}
	first := automationStateFingerprint(action, state)
	action.Label = "Try submit again"
	action.TimeoutMS = 5000
	if automationStateFingerprint(action, state) != first {
		t.Fatal("relabeling bypassed unchanged-state protection")
	}
	if automationStateFingerprint(action, map[string]any{"text": "One item added"}) == first {
		t.Fatal("observable progress not tracked")
	}
}

func TestAutomationMemoryPreservesEarlierRulesAndBoundsEvidence(t *testing.T) {
	r := &core.Run{}
	initial := map[string]any{"url": "https://app.test/start?token=private", "text": "Each attendee costs 200 plus a one-time fee of 10", "controls": []any{map[string]any{"target": "#name", "focused": false}}}
	rememberAutomationObservation(r, initial)
	initial["controls"].([]any)[0].(map[string]any)["focused"] = true
	rememberAutomationObservation(r, initial)
	if len(r.Observations) != 1 {
		t.Fatal("focus-only changes expanded memory")
	}
	for i := 1; i < 20; i++ {
		r.Steps = append(r.Steps, core.Step{})
		rememberAutomationObservation(r, map[string]any{"text": strings.Repeat("a", 15000) + strings.Repeat("b", i)})
	}
	raw, _ := json.Marshal(r.Observations)
	if len(raw) > 96*1024 || len(r.Observations) > 12 || !r.EvidenceOmitted || !strings.Contains(string(raw), "one-time fee of 10") || strings.Contains(string(raw), "token=private") {
		t.Fatal("earlier rules/privacy/budget lost", len(raw), len(r.Observations))
	}
	if !strings.Contains(initial["url"].(string), "private") {
		t.Fatal("observation ledger altered original browser evidence")
	}
}

func TestAutomationTargetCorrectionDoesNotRewriteExpectedValues(t *testing.T) {
	checks := []automationCheck{{Action: core.Action{Operation: "assert", Target: "#wrong", Assertion: &core.Assertion{Kind: "text_contains", Expected: "Submitted: 1"}}}}
	obs := map[string]any{"results": []any{map[string]any{"target": "#count", "text": "Submitted: 1"}}}
	normalizeAutomationCheckTargets(checks, obs)
	if checks[0].Action.Target != "#count" || checks[0].Action.Assertion.Expected != "Submitted: 1" {
		t.Fatal("target not corrected or expectation altered")
	}
	checks[0].Action.Target = "#wrong"
	obs["results"] = []any{map[string]any{"target": "#count", "text": "Submitted: 2"}}
	normalizeAutomationCheckTargets(checks, obs)
	if checks[0].Action.Target != "#wrong" || checks[0].Action.Assertion.Expected != "Submitted: 1" {
		t.Fatal("incorrect application result normalized into a pass")
	}
}

func TestAutomationCompilesOnlyReadOnlyUnnamedRoleSets(t *testing.T) {
	for _, kind := range []string{"count", "hidden", "visible"} {
		checks := []automationCheck{{Action: core.Action{Operation: "assert", Target: "role:alert|", Assertion: &core.Assertion{Kind: kind, Expected: "false"}}}}
		normalizeAutomationCheckTargets(checks, map[string]any{})
		if checks[0].Action.Target != `[role="alert"]` {
			t.Fatal("semantic absence set not compiled", kind, checks)
		}
	}
	for _, action := range []core.Action{
		{Operation: "click", Target: "role:alert|"},
		{Operation: "assert", Target: "role:alert|", Assertion: &core.Assertion{Kind: "text_contains", Expected: "Oops"}},
		{Operation: "assert", Target: `role:alert"] *|`, Assertion: &core.Assertion{Kind: "count", Expected: "0"}},
	} {
		checks := []automationCheck{{Action: action}}
		normalizeAutomationCheckTargets(checks, map[string]any{})
		if checks[0].Action.Target != action.Target {
			t.Fatal("unsupported role target was rewritten", checks)
		}
	}
}
