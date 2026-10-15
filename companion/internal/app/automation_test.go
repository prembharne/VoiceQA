package app

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/native"
)

type automationReplyTransport func(*http.Request) (*http.Response, error)

func (f automationReplyTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestCompletedReplyCorrectionAndReplayFeedbackNeverDuplicateDispatch(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("NVIDIA_API_KEY", "nvapi-fixture")
	calls, dispatched := 0, []string{}
	a.Provider.HTTP = &http.Client{Transport: automationReplyTransport(func(req *http.Request) (*http.Response, error) {
		calls++
		var input struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		_ = json.NewDecoder(req.Body).Decode(&input)
		var payload map[string]any
		_ = json.Unmarshal([]byte(input.Messages[1].Content), &payload)
		if calls == 2 && !strings.Contains(stringField(payload, "validationError"), "valid JSON") {
			t.Error("rejected reply did not receive format feedback")
		}
		if calls == 4 && !strings.Contains(stringField(payload, "validationError"), "will not be replayed") {
			t.Error("repeated action did not receive recovery feedback")
		}
		content := `{"result":{"type":"action","action":{"operation":"click","target":"#folder","label":"Open folder"}}}`
		if calls == 1 {
			content = `{`
		}
		if calls == 4 {
			content = `{"result":{"type":"action","action":{"operation":"key","value":"Enter","label":"Confirm filename"}}}`
		}
		body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "finish_reason": "stop", "message": map[string]any{"content": content}}}})
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(string(body)))}, nil
	})}
	a.Send = func(m native.Message) error {
		if m.Type == "browser.request" {
			var payload map[string]any
			_ = json.Unmarshal(m.Payload, &payload)
			if payload["operation"] == "execute" {
				action := payload["action"].(map[string]any)
				dispatched = append(dispatched, stringField(action, "operation"))
			}
			a.Handle(message("browser.result", map[string]any{"requestId": m.ID, "result": map[string]any{"url": "https://app.test/", "page": "main", "viewport": map[string]any{"width": 1280, "height": 720}}}))
		}
		return nil
	}
	r := core.Run{ID: "correct-before-dispatch", Status: "running", Usage: map[string]int{}, Plan: core.Plan{AIProvider: "nvidia", Model: "nvidia/test", Mode: "automation", Origin: "https://app.test", URL: "https://app.test/", Automation: &core.AutomationPolicy{Live: true, MaxActions: 2}}}
	a.executeAutomation(context.Background(), &r)
	if calls != 4 || strings.Join(dispatched, ",") != "click,key" || len(r.DecisionErrors) != 2 || len(r.Steps) != 2 {
		t.Fatal("recovery duplicated or dropped a dispatch", calls, dispatched, r.DecisionErrors, r.Error)
	}
}

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

func TestMultiPageCompletionUsesScopedAliasesAndBudgetsSwitches(t *testing.T) {
	p := core.Plan{Mode: "automation", URL: "https://app.test/", Origin: "https://app.test", Pages: []core.Page{{Alias: "review", URL: "https://app.test/review", Origin: "https://app.test"}}, Automation: &core.AutomationPolicy{Live: true, MaxActions: 20}}
	scope, _ := core.NewScope(p, "main")
	check := automationCheck{Page: "review", Requirement: "Requested project data", Action: core.Action{Operation: "assert", Target: "#summary", Assertion: &core.Assertion{Kind: "text_contains", Expected: "Aurora"}}}
	other := check
	other.Page = "main"
	checks := []automationCheck{check, other}
	if err := validateAutomationCompletion(p, scope, checks); err != nil {
		t.Fatal(err)
	}
	if scope.Current != "main" || automationCompletionCost("main", checks) != 4 {
		t.Fatal("validation switched scope or ignored transition cost", scope, checks)
	}
	check.Page = "closed"
	if validateAutomationCompletion(p, scope, []automationCheck{check}) == nil {
		t.Fatal("unknown/closed page accepted as completion proof")
	}
}

func TestEmptyAutomationOptionalsNormalizeWithoutDroppingRealHTTPIntent(t *testing.T) {
	a := core.Action{Operation: "open_tab", HTTP: &core.HTTPCheck{}, Assertion: &core.Assertion{}}
	normalizeAutomationOptionals(&a)
	if a.HTTP != nil || a.Assertion != nil {
		t.Fatal("empty unused fields were retained", a)
	}
	a.HTTP = &core.HTTPCheck{Method: "POST", URL: "https://app.test/create"}
	normalizeAutomationOptionals(&a)
	if a.HTTP == nil {
		t.Fatal("meaningful mismatched HTTP intent was silently discarded")
	}
}

func TestTabArgumentCompilationRequiresObservedLinkAndPreservesScope(t *testing.T) {
	p := core.Plan{URL: "https://app.test/", Origin: "https://app.test"}
	scope, _ := core.NewScope(p, "main")
	obs := map[string]any{"url": p.URL, "controls": []any{map[string]any{"href": "https://app.test/review", "name": "Review workspace", "parameterizedLink": false}}}
	a := core.Action{Operation: "open_tab", Target: "role:link|Review workspace", Value: "/review"}
	normalizeAutomationTab(&a, scope, obs)
	if a.Target != "review-workspace" || a.Value != "https://app.test/review" || scope.Current != "main" {
		t.Fatal("observed tab arguments not safely compiled", a, scope)
	}
	for _, input := range []core.Action{
		{Operation: "open_tab", Target: "peer", Value: "Review workspace"},
		{Operation: "open_tab", Target: "https://app.test/review", Value: "peer"},
	} {
		normalizeAutomationTab(&input, scope, obs)
		if input.Target != "peer" || input.Value != "https://app.test/review" {
			t.Fatal("observed label/swapped fields not grounded", input)
		}
	}
	obs["controls"] = append(obs["controls"].([]any), map[string]any{"href": "https://app.test/other", "name": "Review workspace"})
	a = core.Action{Operation: "open_tab", Target: "peer", Value: "Review workspace"}
	normalizeAutomationTab(&a, scope, obs)
	if a.Value != "Review workspace" {
		t.Fatal("ambiguous observed link label was guessed", a)
	}
	a = core.Action{Operation: "open_tab", Target: "role:link|Guessed route", Value: "https://outside.test/review"}
	normalizeAutomationTab(&a, scope, obs)
	if a.Target != "role:link|Guessed route" || scope.Advance(a) == nil {
		t.Fatal("unobserved destination escaped scope", a)
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

func TestFailedLiveAssertionKeepsItsExecutionPageWithoutReplyMetadata(t *testing.T) {
	a := newTestApp(t)
	a.Send = func(m native.Message) error {
		if m.Type == "browser.request" {
			var payload map[string]any
			_ = json.Unmarshal(m.Payload, &payload)
			if payload["operation"] == "execute" {
				a.Handle(message("browser.result", map[string]any{"requestId": m.ID, "code": "assertion_failed", "error": "Expected 84; observed 99", "result": map[string]any{"expected": "84", "actual": "99"}}))
			} else {
				a.Handle(message("browser.result", map[string]any{"requestId": m.ID, "result": map[string]any{"page": "review"}}))
			}
		}
		return nil
	}
	r := core.Run{ID: "failed-peer-check", Status: "running", Plan: core.Plan{Origin: "https://app.test", Mode: "automation"}}
	err := a.runAutomationAction(context.Background(), &r, core.Action{Operation: "assert", Target: "#receipt", Assertion: &core.Assertion{Kind: "number", Expected: "84"}}, "1280x720", "review")
	if err == nil || len(r.Steps) != 1 || r.Steps[0].Page != "review" || r.Steps[0].Status != "failed" {
		t.Fatal("failed assertion lost its explicit execution page", err, r.Steps)
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

func TestReplayFeedbackRejectsMutationButAllowsDifferentNextControl(t *testing.T) {
	action := core.Action{Operation: "click", Target: "#folder"}
	state := map[string]any{"controls": []any{map[string]any{"target": "#folder", "focused": false}, map[string]any{"target": "node:1", "focused": true}}}
	seen := map[string]bool{automationStateFingerprint(action, state): true}
	changed := map[string]any{"controls": []any{map[string]any{"target": "node:1", "focused": false}, map[string]any{"target": "#folder", "focused": true}}}
	if !automationReplayBlocked(action, changed, seen) {
		t.Fatal("focus/reordering bypassed the replay guard")
	}
	if state["controls"].([]any)[0].(map[string]any)["focused"] != false {
		t.Fatal("fingerprint altered live observation")
	}
	if automationReplayBlocked(core.Action{Operation: "fill", Target: "node:1", Value: "Token.sol"}, changed, seen) {
		t.Fatal("blocked a different next action on the current field")
	}
	key := core.Action{Operation: "key", Value: "Enter"}
	if automationStateFingerprint(key, state) == automationStateFingerprint(key, changed) {
		t.Fatal("keyboard actions lost the identity of the focused control")
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

func TestAutomationKeepsWrongObservedResultInsteadOfCheckingAnotherMatchingElement(t *testing.T) {
	checks := []automationCheck{{Action: core.Action{Operation: "assert", Target: "#receipt", Assertion: &core.Assertion{Kind: "text_contains", Expected: "$84.00"}}}}
	obs := map[string]any{"results": []any{
		map[string]any{"target": "#receipt", "text": "$99.00"},
		map[string]any{"target": "#preview", "text": "$84.00"},
	}}
	normalizeAutomationCheckTargets(checks, obs)
	if checks[0].Action.Target != "#receipt" || checks[0].Action.Assertion.Expected != "$84.00" {
		t.Fatal("wrong receipt was replaced by a matching preview", checks)
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
