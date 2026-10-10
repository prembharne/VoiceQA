package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"voiceqa/companion/internal/core"
)

func draftOutput(expected string) map[string]any {
	return map[string]any{"summary": "Reject invalid coupon", "result": map[string]any{"type": "plan", "cases": []any{map[string]any{
		"name": "Invalid coupon", "goal": "Verify rejection", "source": "agent", "steps": []any{
			map[string]any{"operation": "navigate", "target": "", "value": "https://example.test/", "label": "Open shop", "assertion": nil},
			map[string]any{"operation": "assert", "target": "testid:coupon-error", "value": "", "label": "Error visible", "assertion": map[string]any{"kind": "visible", "expected": expected, "tolerance": 0}},
		},
	}}}}
}

func mockStructured(w http.ResponseWriter, draft any) {
	raw, _ := json.Marshal(draft)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"status": "completed", "output": []any{map[string]any{"content": []any{map[string]any{"type": "output_text", "text": string(raw)}}}},
		"usage": map[string]int{"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
	})
}

func TestInvalidBooleanPlanRepairedOnce(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("OPENAI_API_KEY", "fixture-key")
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var body struct {
			Input string `json:"input"`
			Model string `json:"model"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		var input map[string]any
		_ = json.Unmarshal([]byte(body.Input), &input)
		if body.Model != a.settings.Model || input["request"] != "Reject the invalid coupon" || input["approvedOrigin"] != "https://example.test" {
			t.Error("repair changed model or requirements")
		}
		if calls == 1 {
			mockStructured(w, draftOutput("error shown"))
			return
		}
		if !strings.Contains(input["validationError"].(string), "boolean assertion") || input["previousDraft"] == nil {
			t.Error("repair omitted validation feedback")
		}
		mockStructured(w, draftOutput("true"))
	}))
	defer server.Close()
	a.Provider.BaseURL = server.URL
	plan, e := a.draftPlan(context.Background(), "Reject the invalid coupon", "https://example.test/", "https://example.test", true, map[string]any{})
	if e != nil || calls != 2 || core.ValidatePlan(plan) != nil || plan.Confirmed || plan.Usage["total_tokens"] != 30 {
		t.Fatal("repair failed, confirmed prematurely, or lost usage", e, calls)
	}
}

func TestInvalidPlanStopsAfterTwoAttempts(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("OPENAI_API_KEY", "fixture-key")
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; mockStructured(w, draftOutput("yes")) }))
	defer server.Close()
	a.Provider.BaseURL = server.URL
	_, e := a.draftPlan(context.Background(), "Reject coupon", "https://example.test/", "https://example.test", false, nil)
	if calls != 2 || e == nil || !strings.Contains(e.Error(), "after two attempts") {
		t.Fatal("invalid plan was accepted or unbounded repair", calls, e)
	}
	plans, _ := a.Store.List("plan")
	if len(plans) != 0 {
		t.Fatal("invalid plan persisted")
	}
}

func TestPlannerDoesNotRetryAuthenticationErrors(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("OPENAI_API_KEY", "fixture-key")
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"error":{"message":"bad key"}}`))
	}))
	defer server.Close()
	a.Provider.BaseURL = server.URL
	_, e := a.draftPlan(context.Background(), "Reject coupon", "https://example.test/", "https://example.test", false, nil)
	if e == nil || calls != 1 {
		t.Fatal("authentication retried", calls, e)
	}
}

func TestPlannerDoesNotRetryAfterCancellation(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("OPENAI_API_KEY", "fixture-key")
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++; mockStructured(w, draftOutput("yes")); cancel() }))
	defer server.Close()
	a.Provider.BaseURL = server.URL
	_, e := a.draftPlan(ctx, "Reject coupon", "https://example.test/", "https://example.test", false, nil)
	if e == nil || calls != 1 {
		t.Fatal("cancelled plan retried", calls, e)
	}
}

func TestClarificationDiscardsAccompanyingActions(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("OPENAI_API_KEY", "fixture-key")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		draft := draftOutput("yes")
		draft["result"] = map[string]any{"type": "clarification", "question": "What error text should an invalid coupon show?", "cases": draft["result"].(map[string]any)["cases"]}
		mockStructured(w, draft)
	}))
	defer server.Close()
	a.Provider.BaseURL = server.URL
	plan, e := a.draftPlan(context.Background(), "Reject coupon", "https://example.test/", "https://example.test", false, nil)
	if e != nil || plan.Clarification == "" || len(plan.Cases) != 0 || core.ValidatePlan(plan) == nil {
		t.Fatal("clarification carried runnable or invalid actions", e)
	}
}

func TestNonAssertionActionsDiscardUnusedCheckMetadata(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("OPENAI_API_KEY", "fixture-key")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		draft := draftOutput("true")
		steps := draft["result"].(map[string]any)["cases"].([]any)[0].(map[string]any)["steps"].([]any)
		steps[0].(map[string]any)["assertion"] = map[string]any{"kind": "visible", "expected": "yes"}
		mockStructured(w, draft)
	}))
	defer server.Close()
	a.Provider.BaseURL = server.URL
	plan, e := a.draftPlan(context.Background(), "Reject coupon", "https://example.test/", "https://example.test", false, nil)
	if e != nil || plan.Cases[0].Steps[0].Assertion != nil || plan.Cases[0].Steps[1].Assertion == nil {
		t.Fatal("unused checks leaked into review or real check was lost", e)
	}
}
