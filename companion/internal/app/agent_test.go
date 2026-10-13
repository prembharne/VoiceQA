package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"voiceqa/companion/internal/native"
)

func TestAgentCannotDispatchAnUndeclaredMutationTool(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("OPENAI_API_KEY", "fixture-key")
	calls, browserCalls := 0, 0
	a.Send = func(m native.Message) error {
		if m.Type == "browser.request" {
			browserCalls++
		}
		return nil
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		result := map[string]any{"type": "tool", "name": "execute", "args": map[string]string{"page": "main", "target": "#buy", "query": "", "url": ""}}
		if calls > 1 {
			result = map[string]any{"type": "answer", "answer": "The mutation tool was blocked.", "sources": []string{"E1"}}
		}
		raw, _ := json.Marshal(map[string]any{"result": result})
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "completed", "output": []any{map[string]any{"content": []any{map[string]any{"type": "output_text", "text": string(raw)}}}}})
	}))
	defer server.Close()
	a.Provider.BaseURL = server.URL
	answer, err := a.investigate(context.Background(), "Explain the page", "https://example.test", nil, map[string]any{"url": "https://example.test/"}, nil, false, "test-request")
	if err != nil || browserCalls != 0 || len(answer.Evidence) != 2 || answer.Evidence[1].Error == "" {
		t.Fatal("Undeclared mutation escaped tool scope", err, browserCalls, answer)
	}
}

func TestAgentEvidenceDropsURLCredentialsAndBoundsLargeResults(t *testing.T) {
	view := map[string]any{"url": "https://user:secret@example.test/path?token=private#fragment", "controls": []any{map[string]any{"value": strings.Repeat("x", 30000)}}}
	public := agentPublicEvidence(view)
	raw, _ := json.Marshal(public)
	if strings.Contains(string(raw), "private") || strings.Contains(string(raw), "secret") || len(raw) > 24000 {
		t.Fatal("Unbounded or private tool evidence", len(raw))
	}
	if !strings.Contains(view["url"].(string), "private") {
		t.Fatal("Sanitization mutated original browser evidence")
	}
}
