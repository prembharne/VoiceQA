package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPaidAcceptanceBoundsCallsAcrossProviderCopies(t *testing.T) {
	t.Setenv("VOICEQA_ACCEPTANCE_QWEN_LOW_TOKENS", "1")
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/models" {
			writeCatalog(w, testRouterModel("qwen/qwen3.7-flash", []string{"max_tokens", "reasoning", "response_format"}, 65536))
			return
		}
		calls++
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["max_tokens"] != float64(6000) || body["reasoning"].(map[string]any)["enabled"] != false {
			t.Error("Paid acceptance token/reasoning limits missing")
		}
		fmt.Fprint(w, `{"choices":[{"index":0,"message":{"content":"{}"},"finish_reason":"stop"}]}`)
	}))
	defer server.Close()
	base := New()
	for _, provider := range []string{"openai", "nvidia"} {
		c := base.ForProvider(provider)
		c.BaseURL = server.URL
		if _, _, err := c.PlanStructured(context.Background(), "test-key", "other/model", "", nil, Object(nil), nil); err == nil {
			t.Fatal("Acceptance escaped to another provider")
		}
	}
	for i := 0; i < 4; i++ {
		c := base.ForProvider("openrouter")
		c.BaseURL = server.URL
		_, _, err := c.PlanStructured(context.Background(), "sk-or-fixture", "qwen/qwen3.7-flash", "", nil, Object(nil), nil)
		if (i < 3 && err != nil) || (i == 3 && err == nil) {
			t.Fatalf("call %d: %v", i, err)
		}
	}
	if calls != 3 {
		t.Fatalf("Sent %d paid calls", calls)
	}
	c := base.ForProvider("openrouter")
	c.BaseURL = server.URL
	if _, _, err := c.PlanStructured(context.Background(), "sk-or-fixture", "other/model", "", nil, Object(nil), nil); err == nil {
		t.Fatal("Other paid model permitted")
	}
}

func TestCompactJSONRetainsPropertiesAndDoesNotMutateStrictSchema(t *testing.T) {
	strict := ActionSchema()
	before, _ := json.Marshal(strict)
	compact := compactJSONContract(strict).(map[string]any)
	after, _ := json.Marshal(strict)
	if string(before) != string(after) {
		t.Fatal("Strict schema mutated")
	}
	if len(compact["required"].([]string)) != 2 {
		t.Fatal("Unused action fields remain required")
	}
	props := compact["properties"].(map[string]any)
	http := props["http"].(map[string]any)["anyOf"].([]any)[0].(map[string]any)
	if len(http["required"].([]string)) != 3 || http["properties"].(map[string]any)["csrfSource"] == nil {
		t.Fatal("Compact schema lost HTTP scope/private-reference contract")
	}
}
