package app

import (
	"testing"
	"voiceqa/companion/internal/core"
)

func TestDraftURLsExpandOnlyUnambiguousRootPaths(t *testing.T) {
	p := core.Plan{Origin: "https://example.test", Cases: []core.Case{{Steps: []core.Action{
		{Operation: "navigate", Value: "/app/auth?reset=1"},
		{Operation: "navigate", Value: "//evil.test"},
		{Operation: "navigate", Value: "/\\evil.test"},
		{Operation: "switch_tab", Target: "login"},
		{Operation: "navigate", Value: "/profile"},
	}}}}
	normalizeDraftURLs(&p)
	want := []string{"https://example.test/app/auth?reset=1", "//evil.test", "/\\evil.test", "", "/profile"}
	for i, a := range p.Cases[0].Steps {
		if a.Value != want[i] {
			t.Fatalf("step %d: %s", i, a.Value)
		}
	}
}
