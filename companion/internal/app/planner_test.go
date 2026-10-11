package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/native"
)

type routerTestTransport func(*http.Request) (*http.Response, error)

func (f routerTestTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestPromptJSONStillRejectsUnsafeActionsAndKeepsScope(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("OPENROUTER_API_KEY", "sk-or-test-fixture")
	a.settings.AIProvider = "openrouter"
	a.settings.Model = "test/prompt-json"
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/models" {
			fmt.Fprint(w, `{"data":[{"id":"test/prompt-json","supported_parameters":["max_tokens"],"architecture":{"output_modalities":["text"]},"top_provider":{"max_completion_tokens":65536}}]}`)
			return
		}
		calls++
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "test/prompt-json" || body["response_format"] != nil {
			t.Error("changed model or requested unsupported native format")
		}
		draft := draftOutput("true")
		steps := draft["result"].(map[string]any)["cases"].([]any)[0].(map[string]any)["steps"].([]any)
		steps[0].(map[string]any)["operation"] = "evaluate"
		raw, _ := json.Marshal(draft)
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"index": 0, "finish_reason": "stop", "message": map[string]string{"content": string(raw)}}}})
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	a.Provider.HTTP.Transport = routerTestTransport(func(r *http.Request) (*http.Response, error) {
		copy := r.Clone(r.Context())
		copy.URL.Scheme, copy.URL.Host = base.Scheme, base.Host
		copy.URL.Path = strings.TrimPrefix(copy.URL.Path, "/api/v1")
		return http.DefaultTransport.RoundTrip(copy)
	})
	_, err := a.draftPlan(context.Background(), "Check the workflow", "https://example.test/", "https://example.test", false, nil)
	if err == nil || calls != 2 {
		t.Fatal("unvalidated JSON accepted or repair budget changed", err, calls)
	}
	plans, _ := a.Store.List("plan")
	if len(plans) != 0 {
		t.Fatal("unsafe JSON plan persisted")
	}
}

func TestPlannerDeadlineIsFriendlyAndPreservesIdentity(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("OPENAI_API_KEY", "fixture-key")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"response.created\"}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	a.Provider.BaseURL = server.URL
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, err := a.draftPlan(ctx, "Check this workflow", "https://example.test/", "https://example.test", false, nil)
	if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "No tests were run") || strings.Contains(err.Error(), "context deadline exceeded") {
		t.Fatal(err)
	}
}
func TestQueuedPlanningCannotStartAfterStop(t *testing.T) {
	a := newTestApp(t)
	a.Send = func(native.Message) error { t.Fatal("cancelled queued work requested browser access"); return nil }
	generation := a.workGeneration
	_, err := a.dispatch(message("run.cancel", map[string]any{}))
	if err != nil {
		t.Fatal(err)
	}
	_, err = a.dispatchWork(message("plan.propose", map[string]any{}), &generation)
	if !errors.Is(err, context.Canceled) {
		t.Fatal("queued planning revived", err)
	}
}

func TestCancelPlanningRPCDiscardsStreamAndEmitsOnlyScopedProgress(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("OPENAI_API_KEY", "fixture-key")
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"type\":\"response.created\"}\n\n")
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()
	a.Provider.BaseURL = server.URL
	request := message("plan.propose", map[string]any{"request": "Check this workflow", "url": "https://example.test/", "origin": "https://example.test"})
	_, err := a.dispatch(message("project.configure", map[string]any{"url": "https://example.test/", "origin": "https://example.test"}))
	if err != nil {
		t.Fatal(err)
	}
	notices := make(chan native.Message, 10)
	a.Send = func(m native.Message) error {
		if m.Type == "browser.request" {
			a.Handle(message("browser.result", map[string]any{"requestId": m.ID, "result": map[string]any{}}))
		}
		if m.Type == "plan.progress" {
			notices <- m
		}
		return nil
	}
	done := make(chan error, 1)
	go func() { _, err := a.dispatch(request); done <- err }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("provider not started")
	}
	_, err = a.dispatch(message("run.cancel", map[string]any{}))
	if err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
		if !errors.Is(err, context.Canceled) || !strings.Contains(err.Error(), "Planning stopped") {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Stop did not cancel planning")
	}
	close(notices)
	for m := range notices {
		var p map[string]any
		_ = json.Unmarshal(m.Payload, &p)
		if p["requestId"] != request.ID || len(p) != 3 {
			t.Fatal("unscoped or unsanitized progress", p)
		}
	}
	plans, _ := a.Store.List("plan")
	if len(plans) != 0 {
		t.Fatal("cancelled partial plan was persisted")
	}
}

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
