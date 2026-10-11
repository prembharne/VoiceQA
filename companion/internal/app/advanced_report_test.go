package app

import (
	"testing"
	"voiceqa/companion/internal/core"
)

func TestMultiPageBaselinesDoNotCollide(t *testing.T) {
	r := &core.Run{Plan: core.Plan{Origin: "https://app.test", URL: "https://app.test/", Pages: []core.Page{{Alias: "main"}, {Alias: "login"}}}, Steps: []core.Step{{Case: "Same case", Action: core.Action{Label: "Check"}, Viewport: "390x844", Page: "main"}, {Case: "Same case", Action: core.Action{Label: "Check"}, Viewport: "390x844", Page: "login"}}}
	if baselineKey(r, 0) == baselineKey(r, 1) {
		t.Fatal("baselines on different pages collided")
	}
	r.Plan.Pages = nil
	if baselineKey(r, 0) != baselineKey(r, 1) {
		t.Fatal("legacy baseline keys changed")
	}
}
