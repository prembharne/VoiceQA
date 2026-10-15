package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRouterUsesAdvertisedFunctionArgumentsWithoutTokenCap(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/models" {
			writeCatalog(w, testRouterModel("test/tool-model", []string{"tools", "tool_choice", "max_tokens", "response_format"}, 65536))
			return
		}
		calls++
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["stream"] != false || body["max_tokens"] != nil || body["response_format"] != nil || body["model"] != "test/tool-model" {
			t.Error("Function transport changed requested model or output limit")
		}
		if body["tool_choice"] != nil || len(body["tools"].([]any)) != 1 {
			t.Error("Sent a nonportable forced choice or multiple functions")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"index": 0, "finish_reason": "tool_calls", "message": map[string]any{"content": nil, "tool_calls": []any{map[string]any{"type": "function", "function": map[string]any{"name": "submit_result", "arguments": "{\"ok\":true}"}}}}}}, "usage": map[string]int{"prompt_tokens": 8, "completion_tokens": 5, "total_tokens": 13}})
	}))
	defer server.Close()
	c := New().ForProvider("openrouter")
	c.BaseURL = server.URL
	raw, usage, err := c.PlanStructured(context.Background(), "sk-or-fixture", "test/tool-model", "rules", nil, Object(map[string]any{"ok": map[string]any{"type": "boolean"}}), nil)
	if err != nil || string(raw) != "{\"ok\":true}" || usage["total_tokens"] != 13 || calls != 1 {
		t.Fatal("Function arguments not preserved", string(raw), usage, err)
	}
}

func TestFunctionTransportRejectsIncompleteParallelAndUnexpectedCalls(t *testing.T) {
	for _, test := range []struct {
		name, finish, function, args, content string
		count                                 int
	}{
		{name: "wrong function", finish: "tool_calls", function: "evaluate", args: "{}", count: 1},
		{name: "incomplete", finish: "length", function: "submit_result", args: "{}", count: 1},
		{name: "parallel", finish: "tool_calls", function: "submit_result", args: "{}", count: 2},
		{name: "invalid arguments", finish: "tool_calls", function: "submit_result", args: "unfinished", count: 1},
		{name: "nonobject arguments", finish: "tool_calls", function: "submit_result", args: "null", count: 1},
		{name: "mixed content", finish: "tool_calls", function: "submit_result", args: "{}", content: "also do this", count: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := []any{}
			for i := 0; i < test.count; i++ {
				calls = append(calls, map[string]any{"type": "function", "function": map[string]any{"name": test.function, "arguments": test.args}})
			}
			raw, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "finish_reason": test.finish, "message": map[string]any{"content": test.content, "tool_calls": calls}}}})
			if _, _, err := parseToolStructured(raw, 0); err == nil {
				t.Fatal("Ambiguous or incomplete arguments accepted")
			}
		})
	}
}

func TestReviewContractDoesNotRequireUnusedHTTPPadding(t *testing.T) {
	contract := SemanticActionSchema().(map[string]any)
	props := contract["properties"].(map[string]any)
	httpContract := props["http"].(map[string]any)["anyOf"].([]any)[0].(map[string]any)
	required := httpContract["required"].([]string)
	if len(required) != 3 || required[0] != "method" || required[1] != "url" || required[2] != "expectedStatus" {
		t.Fatal("Reviewer requires unused authentication/comparison fields", required)
	}
	// Compaction must not mutate the strict schema used by schema-native models.
	strict := ActionSchema()["properties"].(map[string]any)["http"].(map[string]any)["anyOf"].([]any)[0].(map[string]any)
	if len(strict["required"].([]string)) <= 3 {
		t.Fatal("Review contract changed the strict provider transport")
	}
}
