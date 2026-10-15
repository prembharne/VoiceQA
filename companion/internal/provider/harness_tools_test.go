package provider

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestEmptyAndErrorEnvelopesCannotBecomeToolDecisions(t *testing.T) {
	for _, parser := range []func([]byte, int) (json.RawMessage, map[string]int, error){parseToolStructured, parseChatStructured} {
		for _, test := range []struct {
			raw    string
			status int
		}{
			{`{"error":{"code":502,"message":"secret-sentinel"},"choices":[]}`, 502},
			{`{"error":{"code":"401","message":"secret-sentinel"}}`, 401},
			{`{"error":{"code":402,"message":"secret-sentinel"}}`, 402},
			{`{"error":{"message":"secret-sentinel"}}`, 0},
		} {
			raw, _, err := parser([]byte(test.raw), 0)
			var status *StatusError
			if len(raw) != 0 || !errors.As(err, &status) || status.Status != test.status || strings.Contains(err.Error(), "secret-sentinel") {
				t.Fatal("provider error lost status, leaked data or became a tool", string(raw), err)
			}
		}
		raw, _, err := parser([]byte(`{"choices":[],"error":null}`), 0)
		var empty *EmptyResultError
		if len(raw) != 0 || !errors.As(err, &empty) {
			t.Fatal("missing result not distinguished from refused/invalid tools", err)
		}
	}
}

func TestToolDecisionPrefersNativeToolsWithoutChangingPlanTransport(t *testing.T) {
	for _, supported := range []bool{false, true} {
		t.Run(map[bool]string{false: "schema fallback", true: "native tools"}[supported], func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/models" {
					params := []string{"response_format", "structured_outputs"}
					if supported {
						params = append(params, "tools", "tool_choice")
					}
					writeCatalog(w, testRouterModel("test/dual-mode", params, 460800))
					return
				}
				calls++
				var body map[string]any
				_ = json.NewDecoder(r.Body).Decode(&body)
				if body["max_tokens"] != nil || body["model"] != "test/dual-mode" {
					t.Error("changed model or added an output cap")
				}
				if calls == 1 && supported {
					if body["response_format"] != nil || body["tools"] == nil {
						t.Error("live decision did not use advertised native tools")
					}
					messages := body["messages"].([]any)
					if len(messages) != 4 {
						t.Error("completed tool exchange was lost or undeclared history leaked", len(messages))
						http.Error(w, "invalid completed exchange", 500)
						return
					}
					assistant := messages[2].(map[string]any)
					result := messages[3].(map[string]any)
					call := assistant["tool_calls"].([]any)[0].(map[string]any)
					if result["role"] != "tool" || result["content"] != `{"pattern":"rel-[a-z]{4,8}"}` || result["tool_call_id"] != call["id"] {
						t.Error("actual tool result was not paired to its completed call")
					}
					_, _ = w.Write(functionReply("browser_inspect_element", `{"page":"main","target":"#handle"}`))
					return
				}
				if body["tools"] != nil || body["response_format"] == nil {
					t.Error("unsupported tools or preference leaked into plan call")
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"finish_reason": "stop", "message": map[string]any{"content": `{"result":{"type":"blocked","message":"fixture"}}`}}}})
			}))
			defer server.Close()
			client := New().ForProvider("openrouter")
			client.BaseURL = server.URL
			contract := AutomationLiveStepSchema("main")
			history := []DecisionTurn{
				{Name: "browser_inspect_element", Arguments: `{"page":"main","target":"#handle"}`, Output: `{"pattern":"rel-[a-z]{4,8}"}`},
				{Name: "undeclared_tool", Arguments: `{}`, Output: `{"untrusted":"skip"}`},
			}
			if _, _, err := client.ToolDecision(context.Background(), "sk-or-fixture", "test/dual-mode", "rules", nil, contract, history); err != nil {
				t.Fatal(err)
			}
			if _, _, err := client.PlanStructured(context.Background(), "sk-or-fixture", "test/dual-mode", "rules", nil, contract, nil); err != nil {
				t.Fatal(err)
			}
			if calls != 2 {
				t.Fatal("unexpected provider retries", calls)
			}
		})
	}
}

func TestHarnessContractsRoundTripWithoutChangingDecisions(t *testing.T) {
	schema := AutomationLiveStepSchema("", "main")
	for _, raw := range []string{
		`{"result":{"type":"action","action":{"operation":"fill","target":"#handle","value":"rel-launch","label":"Enter handle"}}}`,
		`{"result":{"type":"tool","name":"inspect_element","args":{"page":"main","target":"#handle"}}}`,
		`{"result":{"type":"complete","checks":[{"requirement":"Saved record","page":"main","action":{"operation":"assert","target":"#status","assertion":{"kind":"text","expected":"Ready"},"label":"Check result"}}]}}`,
	} {
		name, args, err := EncodeDecisionTool(schema, json.RawMessage(raw))
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := DecodeDecisionTool(schema, name, args)
		if err != nil {
			t.Fatal(err)
		}
		var want, got any
		_ = json.Unmarshal([]byte(raw), &want)
		_ = json.Unmarshal(decoded, &got)
		if !reflect.DeepEqual(want, got) {
			t.Fatalf("decision changed: %s -> %s", raw, decoded)
		}
	}
	if _, err := DecodeDecisionTool(schema, "browser_fill", `{"target":"#handle","value":"x","label":"Fill","script":"steal()"}`); err == nil {
		t.Fatal("undeclared capability accepted")
	}
}
