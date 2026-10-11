package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testRouterModel(id string, params []string, limit int) routerModel {
	m := routerModel{ID: id, Parameters: params}
	m.Top.MaxCompletion = limit
	m.Architecture.Output = []string{"text"}
	return m
}
func writeCatalog(w http.ResponseWriter, models ...routerModel) {
	_ = json.NewEncoder(w).Encode(map[string]any{"data": models})
}

func TestRouterChoosesSupportedFormatsAndBoundsOutput(t *testing.T) {
	for _, tt := range []struct {
		name       string
		params     []string
		limit      int
		mode       string
		wantBudget int
	}{
		{"Dots schema", []string{"response_format", "structured_outputs", "max_tokens"}, 460800, "json_schema", 32768},
		{"Qwen JSON", []string{"response_format", "max_tokens", "reasoning"}, 65536, "json_object", 32768},
		{"Nemotron prompt", []string{"max_tokens", "reasoning"}, 65536, "", 32768},
		{"Small endpoint", []string{"max_tokens"}, 8192, "", 8192},
		{"Small reasoning endpoint", []string{"max_tokens", "reasoning"}, 2048, "", 2048},
	} {
		t.Run(tt.name, func(t *testing.T) {
			catalogs, calls := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/models" {
					catalogs++
					if r.Header.Get("Authorization") != "" {
						t.Error("API key leaked to public catalog")
					}
					m := testRouterModel("test/selected-model", tt.params, tt.limit)
					m.Reasoning.MaxTokens = true
					writeCatalog(w, m)
					return
				}
				calls++
				if r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer sk-or-fixture" {
					t.Error("model request misrouted")
				}
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body["model"] != "test/selected-model" || body["max_tokens"] != float64(tt.wantBudget) || body["provider"].(map[string]any)["require_parameters"] != true {
					t.Error("changed model/budget or disabled parameter routing")
				}
				if body["stream_options"] != nil {
					t.Error("sent an unnecessary provider parameter")
				}
				if tt.mode == "" {
					if body["response_format"] != nil {
						t.Error("sent unsupported formatting parameter")
					}
				} else if body["response_format"].(map[string]any)["type"] != tt.mode {
					t.Error("wrong output mode")
				}
				instructions := body["messages"].([]any)[0].(map[string]any)["content"].(string)
				if tt.mode != "json_schema" && !strings.Contains(instructions, "properties") {
					t.Error("omitted local JSON contract")
				}
				if strings.Contains(strings.Join(tt.params, ","), "reasoning") && body["reasoning"].(map[string]any)["max_tokens"] != float64(max(1024, min(4096, tt.wantBudget/4))) {
					t.Error("did not reserve tokens for visible output")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, `data: {"choices":[{"index":0,"delta":{"content":"{\"summary\":\"draft\"}"},"finish_reason":"stop"}]}`+"\n\ndata: [DONE]\n\n")
			}))
			defer server.Close()
			c := New().ForProvider("openrouter")
			c.BaseURL = server.URL
			for i := 0; i < 2; i++ {
				raw, _, err := c.PlanStructured(context.Background(), "sk-or-fixture", "test/selected-model", "rules", nil, Object(map[string]any{"summary": String()}), nil)
				if err != nil || string(raw) != `{"summary":"draft"}` {
					t.Fatal(string(raw), err)
				}
			}
			if catalogs != 1 || calls != 2 {
				t.Fatal("catalog not cached or generation retried", catalogs, calls)
			}
		})
	}
}

func TestRouterRejectsUnavailableCapabilitiesAndUnsupportedModels(t *testing.T) {
	for _, kind := range []string{"catalog error", "unknown model", "nontext", "tiny budget"} {
		t.Run(kind, func(t *testing.T) {
			generated := false
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/models" {
					generated = true
					t.Error("generated despite unusable capabilities")
					return
				}
				if kind == "catalog error" {
					w.WriteHeader(503)
					return
				}
				m := testRouterModel("test/model", nil, 32000)
				if kind == "unknown model" {
					m.ID = "test/other"
				}
				if kind == "nontext" {
					m.Architecture.Output = []string{"image"}
				}
				if kind == "tiny budget" {
					m.Top.MaxCompletion = 256
				}
				writeCatalog(w, m)
			}))
			defer server.Close()
			c := New().ForProvider("openrouter")
			c.BaseURL = server.URL
			_, _, err := c.PlanStructured(context.Background(), "sk-or-fixture", "test/model", "rules", nil, nil, nil)
			if err == nil || generated {
				t.Fatal("unusable model accepted", err)
			}
		})
	}
}
func TestRouterOutputLimitIsNotSilentlyRetried(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/models" {
			writeCatalog(w, testRouterModel("test/model", []string{"max_tokens"}, 65536))
			return
		}
		calls++
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, `data: {"choices":[{"index":0,"delta":{"content":"{}"},"finish_reason":"length"}]}`+"\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()
	c := New().ForProvider("openrouter")
	c.BaseURL = server.URL
	raw, _, err := c.PlanStructured(context.Background(), "sk-or-fixture", "test/model", "rules", nil, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "32768 tokens") || len(raw) != 0 || calls != 1 {
		t.Fatal("lost budget or replayed a truncated generation", err, calls)
	}
}
func TestPromptJSONOnlyUnwrapsOneExactFence(t *testing.T) {
	for _, text := range []string{"```json\n{\"target\":\"#submit\"}\n```", "```\n{\"target\":\"#submit\"}\n```"} {
		body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "finish_reason": "stop", "message": map[string]string{"content": text}}}})
		if _, _, err := parseChatStructuredMode(body, 32000, true); err != nil {
			t.Fatal(err)
		}
		if _, _, err := parseChatStructuredMode(body, 32000, false); err == nil {
			t.Fatal("strict output accepted a fence")
		}
	}
	body, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "finish_reason": "stop", "message": map[string]string{"content": "prefix\n```json\n{}\n```"}}}})
	if _, _, err := parseChatStructuredMode(body, 32000, true); err == nil {
		t.Fatal("searched arbitrary prose for executable JSON")
	}
}
func TestRouterTerminalUsageCanRepeatAnEmptyStop(t *testing.T) {
	prefix := `data: {"choices":[{"index":0,"delta":{"content":"{}"},"finish_reason":"stop"}]}` + "\n\n"
	usage := `data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":4,"total_tokens":12}}` + "\n\ndata: [DONE]\n\n"
	raw, err := readChatStream(strings.NewReader(prefix+usage), nil)
	if err != nil {
		t.Fatal(err)
	}
	_, tokens, err := parseChatStructured(raw, 32000)
	if err != nil || tokens["total_tokens"] != 12 {
		t.Fatal("terminal usage lost", tokens, err)
	}
	late := `data: {"choices":[{"index":0,"delta":{"content":"late"},"finish_reason":"stop"}]}` + "\n\ndata: [DONE]\n\n"
	if _, err := readChatStream(strings.NewReader(prefix+late), nil); err == nil {
		t.Fatal("post-completion text accepted")
	}
}
