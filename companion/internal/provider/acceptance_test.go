package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNemotronAcceptanceRejectsOtherModelsBeforeNetwork(t *testing.T) {
	t.Setenv("VOICEQA_ACCEPTANCE_MODEL", "nvidia/nemotron-3.5-super-vl:free")
	c := New().ForProvider("openrouter")
	for _, model := range []string{"qwen/qwen3.7-flash", "dots-studio/dots-3-note-preview:free"} {
		if err := c.checkAcceptanceModel(model); err == nil {
			t.Fatal("acceptance escaped to another model")
		}
		if _, _, err := c.ToolDecision(context.Background(), "", model, "", nil, Object(nil), nil); err == nil {
			t.Fatal("tool decisions bypassed exact-model restriction")
		}
	}
	if err := c.checkAcceptanceModel("nvidia/nemotron-3.5-super-vl:free"); err != nil {
		t.Fatal(err)
	}
	if err := c.ForProvider("openai").checkAcceptanceModel("nvidia/nemotron-3.5-super-vl:free"); err == nil {
		t.Fatal("acceptance escaped to another provider")
	}
}

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

func TestPaidAcceptanceAllowsFourBoundedDraftAndReviewCalls(t *testing.T) {
	t.Setenv("VOICEQA_ACCEPTANCE_QWEN_LOW_TOKENS", "1")
	budgets := []int{6000, 1800, 6000, 1800}
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/models" {
			writeCatalog(w, testRouterModel("qwen/qwen3.7-flash", []string{"max_tokens", "reasoning", "response_format"}, 65536))
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if calls >= len(budgets) || body["max_tokens"] != float64(budgets[calls]) {
			t.Error("Unexpected acceptance budget")
		}
		calls++
		fmt.Fprint(w, `{"choices":[{"index":0,"message":{"content":"{}"},"finish_reason":"stop"}]}`)
	}))
	defer server.Close()
	base := New()
	for _, budget := range budgets {
		c := base.ForProvider("openrouter")
		c.BaseURL = server.URL
		if _, _, err := c.StructuredWithBudget(context.Background(), "sk-or-fixture", "qwen/qwen3.7-flash", "", nil, Object(nil), budget); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 4 || base.acceptanceTokens.Load() != 2400 {
		t.Fatal("Aggregate output reservation lost", calls, base.acceptanceTokens.Load())
	}
	c := base.ForProvider("openrouter")
	c.BaseURL = server.URL
	if _, _, err := c.StructuredWithBudget(context.Background(), "sk-or-fixture", "qwen/qwen3.7-flash", "", nil, Object(nil), 1800); err == nil || calls != 4 {
		t.Fatal("Fifth paid call was dispatched")
	}
}

func TestAuthorizedUncappedQwenDoesNotSendTokenOrCallCaps(t *testing.T) {
	t.Setenv("VOICEQA_ACCEPTANCE_QWEN", "1")
	t.Setenv("VOICEQA_ACCEPTANCE_QWEN_LOW_TOKENS", "")
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/models" {
			writeCatalog(w, testRouterModel("qwen/qwen3.7-flash", []string{"max_tokens", "response_format"}, 65536))
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["max_tokens"] != nil || body["model"] != "qwen/qwen3.7-flash" {
			t.Error("Uncapped Qwen request changed model or imposed output cap")
		}
		calls++
		fmt.Fprint(w, `{"choices":[{"index":0,"message":{"content":"{}"},"finish_reason":"stop"}]}`)
	}))
	defer server.Close()
	base := New()
	for i := 0; i < 5; i++ {
		c := base.ForProvider("openrouter")
		c.BaseURL = server.URL
		if _, _, err := c.PlanStructured(context.Background(), "sk-or-fixture", "qwen/qwen3.7-flash", "", nil, Object(nil), nil); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 5 || base.acceptanceCalls != nil || base.acceptanceTokens != nil {
		t.Fatal("Legacy paid-test caps remain active")
	}
}
