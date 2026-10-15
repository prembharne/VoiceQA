package provider

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestStructuredFormatDiagnosticsNeverContainResponseValues(t *testing.T) {
	for _, test := range []struct{ raw, format string }{
		{"", "empty"}, {"```json\n{\"private\":\"secret-sentinel\"}\n```", "markdown-fence"},
		{"{\"private\":\"secret-sentinel", "malformed-object"}, {"secret-sentinel", "text"},
	} {
		err := structuredFormatError([]byte(test.raw)).Error()
		if strings.Contains(err, "secret-sentinel") || !strings.Contains(err, "format="+test.format) {
			t.Fatal("Unsafe or ambiguous provider diagnostics", err)
		}
	}
}

func functionReply(name, arguments string) []byte {
	raw, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "finish_reason": "tool_calls", "message": map[string]any{"content": nil, "tool_calls": []any{map[string]any{"type": "function", "function": map[string]any{"name": name, "arguments": arguments}}}}}}})
	return raw
}

func TestNativeLiveFunctionsSelectOneTypedActionWithoutWrapper(t *testing.T) {
	functions, contracts := nativeResultFunctions(AutomationLiveStepSchema("main", "review"))
	if len(functions) < 15 || contracts["browser_click"].Operation != "click" || contracts["browser_http_check"].Operation != "http_check" {
		t.Fatal("Operation-specific functions were not exposed")
	}
	args := contracts["browser_click"].Parameters["properties"].(map[string]any)
	if args["target"] == nil || args["operation"] != nil || args["http"] != nil || args["result"] != nil {
		t.Fatal("Click function includes unrelated dispatch/wrapper fields", args)
	}
	raw, usage, err := parseDeclaredToolStructured(functionReply("browser_click", `{"target":"#next","label":"Advance","timeoutMs":0}`), 0, contracts)
	var packet struct {
		Result struct {
			Type   string `json:"type"`
			Action struct {
				Operation string `json:"operation"`
				Target    string `json:"target"`
			} `json:"action"`
		} `json:"result"`
	}
	if err != nil || json.Unmarshal(raw, &packet) != nil || packet.Result.Type != "action" || packet.Result.Action.Operation != "click" || packet.Result.Action.Target != "#next" || usage["typed_function_calls"] != 1 {
		t.Fatal("Declared action not restored exactly", string(raw), err)
	}
	for _, reply := range [][]byte{
		functionReply("browser_click", `{"target":"#next","operation":"fill"}`),
		functionReply("browser_click", `{"target":"#next","http":{"method":"DELETE"}}`),
		functionReply("browser_evaluate", `{"code":"anything"}`),
		functionReply("submit_result", `{"result":{"type":"complete"}}`),
	} {
		if _, _, err := parseDeclaredToolStructured(reply, 0, contracts); err == nil {
			t.Fatal("Undeclared operation or argument reached the controller")
		}
	}
}

func TestNativePlanAndInvestigationFunctionsRestoreTheirExactEnvelopes(t *testing.T) {
	_, contracts := nativeResultFunctions(PlanSchema())
	if len(contracts) != 2 || contracts["report_plan"].Kind != "plan" || contracts["report_clarification"].Kind != "clarification" {
		t.Fatal("Plan alternatives not split into their declared functions")
	}
	raw, _, err := parseDeclaredToolStructured(functionReply("report_clarification", `{"summary":"Business rule missing","question":"What is the cancellation window?"}`), 0, contracts)
	var packet map[string]any
	_ = json.Unmarshal(raw, &packet)
	if err != nil || packet["summary"] != "Business rule missing" || packet["result"].(map[string]any)["type"] != "clarification" || packet["result"].(map[string]any)["question"] != "What is the cancellation window?" {
		t.Fatal("Clarification/root metadata changed", string(raw), err)
	}
	_, contracts = nativeResultFunctions(AgentSchema([]string{"inspect_element", "read_link"}, []string{"O1"}))
	if _, _, err := parseDeclaredToolStructured(functionReply("browser_click", `{"target":"#submit"}`), 0, contracts); err == nil {
		t.Fatal("Read-only request accepted an execution function from another mode")
	}
	raw, _, err = parseDeclaredToolStructured(functionReply("browser_inspect_element", `{"page":"main","target":"#receipt"}`), 0, contracts)
	_ = json.Unmarshal(raw, &packet)
	result := packet["result"].(map[string]any)
	if err != nil || result["type"] != "tool" || result["name"] != "inspect_element" || result["args"].(map[string]any)["target"] != "#receipt" {
		t.Fatal("Read-only investigation changed to an action", string(raw), err)
	}
}

func TestPlainFunctionArgumentsRequireAnUnambiguousDeclaredSignature(t *testing.T) {
	_, contracts := nativeResultFunctions(AutomationLiveStepSchema("main"))
	raw, restored, err := restoreUniqueFunctionReply(json.RawMessage(`{"checks":[]}`), contracts)
	if err != nil || !restored || !strings.Contains(string(raw), `"type":"complete"`) {
		t.Fatal("Unique completion arguments lost their declared envelope", string(raw), err)
	}
	for _, input := range []string{
		`{"target":"#field","value":"value","label":"Choose","timeoutMs":0}`,
		`{"checks":[],"allowConsequential":true}`,
		`{"operation":"evaluate","value":"anything"}`,
	} {
		if output, restored, err := restoreUniqueFunctionReply(json.RawMessage(input), contracts); err != nil || restored || string(output) != input {
			t.Fatal("Ambiguous/undeclared fields implied an operation", string(output), err)
		}
	}
}
