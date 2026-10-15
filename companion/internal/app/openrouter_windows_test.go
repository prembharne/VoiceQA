//go:build windows

package app

import (
	"encoding/json"
	"strings"
	"testing"
	"voiceqa/companion/internal/core"
)

func TestOpenRouterMigrationAndCredentialIsolation(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("OPENROUTER_API_KEY", "")
	t.Setenv("VOICEQA_TTS_API_KEY", "")
	if e := a.saveSecret("api-key.dpapi", "sk-or-legacy-fixture"); e != nil {
		t.Fatal(e)
	}
	b := New(a.Store, a.Send)
	s := b.getSettings()
	if s.AIProvider != "openrouter" || s.Model != dotsModel || !s.HasAPIKey {
		t.Fatal("legacy router key not recovered")
	}
	if b.speechKey() != "" || b.ttsKey(s) != "" {
		t.Fatal("router key leaked into speech")
	}
	s.APIKey = "sk-or-new-fixture"
	s.SpeechAPIKey = "openai-speech-fixture"
	result, e := b.dispatch(message("settings.save", s))
	if e != nil {
		t.Fatal(e)
	}
	public := result.(core.Settings)
	encoded, _ := json.Marshal(public)
	if strings.Contains(string(encoded), "fixture") || public.APIKey != "" || public.SpeechAPIKey != "" {
		t.Fatal("secret exposed")
	}
	var persisted core.Settings
	if e := b.Store.Get("settings", "default", &persisted); e != nil {
		t.Fatal(e)
	}
	if persisted.APIKey != "" || persisted.SpeechAPIKey != "" {
		t.Fatal("secret persisted in JSON")
	}
	if b.keyFor("openrouter") != s.APIKey || b.speechKey() != s.SpeechAPIKey {
		t.Fatal("credentials not isolated")
	}
	public.AIProvider = "openai"
	public.Model = "fixture-model"
	if _, e = b.dispatch(message("settings.save", public)); e != nil {
		t.Fatal(e)
	}
	if b.getSettings().HasAPIKey {
		t.Fatal("router key treated as OpenAI key")
	}
	public.AIProvider = "openrouter"
	public.Model = "openai/gpt-4o"
	if _, e = b.dispatch(message("settings.save", public)); e != nil {
		t.Fatal(e)
	}
	if b.keyFor("openrouter") != s.APIKey {
		t.Fatal("blank key erased saved credential")
	}
}

func TestRouterKeyRejectedInOpenAISlots(t *testing.T) {
	for _, field := range []string{"apiKey", "speechApiKey", "ttsApiKey"} {
		a := newTestApp(t)
		if _, e := a.dispatch(message("settings.save", map[string]any{"aiProvider": "openai", "model": "fixture-model", field: "sk-or-fixture"})); e == nil {
			t.Fatalf("accepted router key in %s", field)
		}
	}
}
