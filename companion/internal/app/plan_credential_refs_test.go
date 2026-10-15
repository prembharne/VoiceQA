package app

import (
	"testing"
	"voiceqa/companion/internal/core"
)

func TestCredentialWrapperCompilationRetainsOriginAndProfileBoundaries(t *testing.T) {
	profiles := []AuthProfile{{ID: "manager", Origin: "https://app.test", HasUsername: true, HasPassword: true}}
	for _, test := range []struct{ name, page, previous, value, want string }{
		{name: "exact redundant wrapper", value: "ACTUAL_PROFILE_ID:manager:username", want: "manager:username"},
		{name: "unknown id", value: "ACTUAL_PROFILE_ID:unknown:username", want: "ACTUAL_PROFILE_ID:unknown:username"},
		{name: "unknown secret field", value: "ACTUAL_PROFILE_ID:manager:token", want: "ACTUAL_PROFILE_ID:manager:token"},
		{name: "different page origin", page: "peer", value: "ACTUAL_PROFILE_ID:manager:password", want: "ACTUAL_PROFILE_ID:manager:password"},
		{name: "ambiguous tab scope", previous: "switch_tab", value: "ACTUAL_PROFILE_ID:manager:password", want: "ACTUAL_PROFILE_ID:manager:password"},
	} {
		t.Run(test.name, func(t *testing.T) {
			p := core.Plan{Origin: "https://app.test", Pages: []core.Page{{Alias: "peer", Origin: "https://peer.test"}}, Cases: []core.Case{{Page: test.page}}}
			if test.previous != "" {
				p.Cases[0].Steps = append(p.Cases[0].Steps, core.Action{Operation: test.previous, Target: "peer"})
			}
			p.Cases[0].Steps = append(p.Cases[0].Steps, core.Action{Operation: "fill_secret", Value: test.value})
			normalizeCredentialWrappers(&p, profiles)
			if got := p.Cases[0].Steps[len(p.Cases[0].Steps)-1].Value; got != test.want {
				t.Fatalf("got %q want %q", got, test.want)
			}
		})
	}
}
