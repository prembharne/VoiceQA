package app

import (
	"testing"
	"voiceqa/companion/internal/core"
)

func TestDraftBearerSourcesAreObservedAndOriginBound(t *testing.T) {
	p := core.Plan{Origin: "https://app.test", Cases: []core.Case{{Steps: []core.Action{{Operation: "http_check", HTTP: &core.HTTPCheck{URL: "https://app.test/api/order", AuthSource: "local:session"}}}}}, Pages: []core.Page{{Alias: "peer", Origin: "https://peer.test"}}}
	obs := map[string]any{"authSources": []string{}, "additionalPages": map[string]any{"peer": map[string]any{"authSources": []string{"local:session"}}}}
	if validateDraftAuthSources(p, obs) == nil {
		t.Fatal("Borrowed bearer source from another origin")
	}
	obs["authSources"] = []string{"local:session"}
	if err := validateDraftAuthSources(p, obs); err != nil {
		t.Fatal(err)
	}
	p.Cases[0].Steps[0].HTTP.AuthSource = ""
	obs["authSources"] = []string{}
	if err := validateDraftAuthSources(p, obs); err != nil {
		t.Fatal("Default cookie session was rejected", err)
	}
}
