package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestStructuredRequestAndResponse(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/responses" || r.Header.Get("Authorization") != "Bearer secret" {
			t.Error("incorrect provider request")
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		format := body["text"].(map[string]any)["format"].(map[string]any)
		if format["strict"] != true {
			t.Error("schema is not strict")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"completed","output":[{"content":[{"type":"output_text","text":"{\"target\":\"#submit\"}"}]}],"usage":{"input_tokens":12,"output_tokens":4,"total_tokens":16,"input_tokens_details":{"cached_tokens":3},"output_tokens_details":{"reasoning_tokens":2}}}`))
	}))
	defer s.Close()
	c := New()
	c.BaseURL = s.URL
	raw, usage, e := c.Structured(context.Background(), "secret", "model", "instructions", map[string]string{"request": "click"}, Object(map[string]any{"target": String()}))
	if e != nil || !strings.Contains(string(raw), "submit") || usage["input_tokens"] != 12 {
		t.Fatal(string(raw), usage, e)
	}
}
func TestMissingKeyDoesNotCallProvider(t *testing.T) {
	c := New()
	if _, _, e := c.Structured(context.Background(), "", "model", "", nil, nil); e == nil {
		t.Fatal("missing key accepted")
	}
}

func TestOpenRouterStructuredRouting(t *testing.T) {
	base := New()
	c := base.ForProvider("openrouter")
	if c.BaseURL != "https://openrouter.ai/api/v1" || base.BaseURL != "https://api.openai.com/v1" {
		t.Fatal("provider routing mutated speech endpoint")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/responses" || r.Header.Get("Authorization") != "Bearer sk-or-fixture" {
			t.Error("incorrect router request")
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "openai/gpt-4o" || body["provider"].(map[string]any)["require_parameters"] != true {
			t.Error("model or strict routing missing")
		}
		if body["text"].(map[string]any)["format"].(map[string]any)["strict"] != true {
			t.Error("strict schema missing")
		}
		_, _ = w.Write([]byte(`{"status":"completed","output":[{"content":[{"type":"output_text","text":"{\"target\":\"#submit\"}"}]}],"usage":{"input_tokens":8,"output_tokens":4,"total_tokens":12}}`))
	}))
	defer server.Close()
	c.BaseURL = server.URL
	raw, usage, e := c.Structured(context.Background(), "sk-or-fixture", "openai/gpt-4o", "instructions", nil, Object(map[string]any{"target": String()}))
	if e != nil || !strings.Contains(string(raw), "#submit") || usage["total_tokens"] != 12 {
		t.Fatal("router response not parsed", e)
	}
}

func TestOpenAIRejectsRouterKeyBeforeNetwork(t *testing.T) {
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer server.Close()
	c := New()
	c.BaseURL = server.URL
	if _, _, e := c.Structured(context.Background(), "sk-or-fixture", "model", "", nil, nil); e == nil || called {
		t.Fatal("router key sent to OpenAI")
	}
}
func TestProviderErrorRedactsKey(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		_, _ = w.Write([]byte(`{"error":{"message":"secret was rejected"}}`))
	}))
	defer s.Close()
	c := New()
	c.BaseURL = s.URL
	_, _, e := c.Structured(context.Background(), "secret", "model", "", nil, nil)
	if e == nil || strings.Contains(e.Error(), "secret") {
		t.Fatal(e)
	}
}
