package app

import (
	"testing"
	"voiceqa/companion/internal/core"
)

func TestDropdownCompilationUsesExactDocumentEvidence(t *testing.T) {
	obs := map[string]any{"url": "https://test.example/", "controls": []any{map[string]any{
		"target": "#workshop", "role": "combobox", "options": []any{map[string]any{"value": "advanced"}},
	}}}
	cases := []core.Case{{Steps: []core.Action{
		{Operation: "navigate", Value: "https://test.example/"},
		{Operation: "fill", Target: "#workshop", Value: "advanced"},
		{Operation: "fill", Target: "#workshop", Value: "unlisted"},
		{Operation: "navigate", Value: "https://test.example/other"},
		{Operation: "fill", Target: "#workshop", Value: "advanced"},
	}}}
	normalizeDraftControls(cases, obs)
	steps := cases[0].Steps
	if steps[1].Operation != "select" || steps[2].Operation != "fill" || steps[4].Operation != "fill" {
		t.Fatal("compiled an unobserved option or crossed a document boundary", steps)
	}
}
