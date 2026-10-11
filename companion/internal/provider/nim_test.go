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

func TestNVIDIAChatRoutingStreamingAndStructuredGrounding(t *testing.T) {
	base := New()
	c := base.ForProvider("nvidia")
	for _, name := range []string{"openai", "openrouter"} {
		if err := c.ForProvider(name).ValidateKey("nvapi-fixture"); err == nil {
			t.Fatal("chained provider retained NVIDIA privileges")
		}
	}
	if c.BaseURL != "https://integrate.api.nvidia.com/v1" || !c.NIM || base.NIM || base.BaseURL != "https://api.openai.com/v1" {
		t.Fatal("NVIDIA routing mutated another provider")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer nvapi-fixture" {
			t.Error("wrong NVIDIA endpoint/key")
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "nvidia/test-model" || body["response_format"].(map[string]any)["json_schema"].(map[string]any)["strict"] != true {
			t.Error("model or structured format missing")
		}
		if body["stream"] == true {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, `data: {"choices":[{"index":0,"delta":{"content":"{\"target\":"}}]}`+"\n\n")
			fmt.Fprint(w, `data: {"choices":[{"index":0,"delta":{"reasoning_content":"never publish reasoning","content":"\"#submit\"}"},"finish_reason":"stop"}]}`+"\n\n")
			fmt.Fprint(w, `data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}}`+"\n\ndata: [DONE]\n\n")
		} else {
			fmt.Fprint(w, `{"choices":[{"index":0,"message":{"content":"{\"target\":\"#submit\"}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}}`)
		}
	}))
	defer server.Close()
	c.BaseURL = server.URL
	for _, stream := range []bool{false, true} {
		var raw json.RawMessage
		var usage map[string]int
		var err error
		if stream {
			raw, usage, err = c.PlanStructured(context.Background(), "nvapi-fixture", "nvidia/test-model", "rules", nil, Object(map[string]any{"target": String()}), nil)
		} else {
			raw, usage, err = c.Structured(context.Background(), "nvapi-fixture", "nvidia/test-model", "rules", nil, Object(map[string]any{"target": String()}))
		}
		if err != nil || string(raw) != `{"target":"#submit"}` || usage["total_tokens"] != 19 {
			t.Fatal(string(raw), usage, err)
		}
	}
}
func TestNVIDIARejectsIncompleteStreamsAndNeverCrossesProviderKeys(t *testing.T) {
	for _, raw := range []string{
		`data: {"choices":[{"index":0,"delta":{"content":"{}"}}]}` + "\n\ndata: [DONE]\n\n",
		`data: {"choices":[{"index":0,"delta":{"content":"{}"},"finish_reason":"stop"}]}` + "\n\n",
		`data: {"choices":[{"index":0,"delta":{"content":"{}"},"finish_reason":"length"}]}` + "\n\ndata: [DONE]\n\n",
		`data: {"choices":[{"index":0,"delta":{"refusal":"No"},"finish_reason":"stop"}]}` + "\n\ndata: [DONE]\n\n",
	} {
		if _, err := readChatStream(strings.NewReader(raw), nil); err == nil {
			t.Fatal("unfinished/refused answer accepted")
		}
	}
	for _, name := range []string{"openai", "openrouter"} {
		if err := New().ForProvider(name).ValidateKey("nvapi-fixture"); err == nil {
			t.Fatal("NVIDIA key leaked into", name)
		}
	}
	for _, key := range []string{"sk-or-fixture", "sk-openai-fixture"} {
		if err := New().ForProvider("nvidia").ValidateKey(key); err == nil {
			t.Fatal("foreign key accepted by NVIDIA")
		}
	}
}
