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

func TestRelativeHTTPUsesKnownActiveOriginWithoutRepairingExternalHosts(t *testing.T) {
	p := core.Plan{Origin: "https://app.test", Pages: []core.Page{{Alias: "peer", Origin: "https://peer.test", URL: "https://peer.test/"}}, Cases: []core.Case{{Steps: []core.Action{
		{Operation: "navigate", Value: "https://peer.test/"},
		{Operation: "http_check", HTTP: &core.HTTPCheck{URL: "/api/orders/${order-id}"}},
		{Operation: "http_check", HTTP: &core.HTTPCheck{URL: "//outside.test/api"}},
		{Operation: "http_check", HTTP: &core.HTTPCheck{URL: "/\\outside.test/api"}},
		{Operation: "switch_tab", Target: "main"},
		{Operation: "http_check", HTTP: &core.HTTPCheck{URL: "/api/me"}},
	}}}}
	normalizeDraftURLs(&p)
	want := []string{"https://peer.test/api/orders/${order-id}", "//outside.test/api", "/\\outside.test/api", "/api/me"}
	for i, index := range []int{1, 2, 3, 5} {
		if p.Cases[0].Steps[index].HTTP.URL != want[i] {
			t.Fatal("relative HTTP expansion altered scope or template", p)
		}
	}
}
