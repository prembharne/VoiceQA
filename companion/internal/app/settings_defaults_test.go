package app

import (
	"testing"
	"voiceqa/companion/internal/native"
	"voiceqa/companion/internal/store"
)

func TestStartupModelRoutePreservesExplicitAndLegacyChoices(t *testing.T) {
	for _, test := range []struct {
		name, provider, model string
		saved                 map[string]any
	}{
		{"fresh install", "openrouter", dotsModel, nil},
		{"explicit NVIDIA", "nvidia", "nvidia/test", map[string]any{"aiProvider": "nvidia", "model": "nvidia/test"}},
		{"explicit OpenRouter model", "openrouter", "qwen/qwen3.7-flash", map[string]any{"aiProvider": "openrouter", "model": "qwen/qwen3.7-flash"}},
		{"legacy OpenAI", "openai", "existing-openai-model", map[string]any{"model": "existing-openai-model"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, err := store.Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			if test.saved != nil {
				if err = s.Put("settings", "default", test.saved); err != nil {
					t.Fatal(err)
				}
			}
			a := New(s, func(native.Message) error { return nil })
			defer a.Close()
			settings := a.getSettings()
			if settings.AIProvider != test.provider || settings.Model != test.model {
				t.Fatal("startup changed the intended route", settings.AIProvider, settings.Model)
			}
		})
	}
}
