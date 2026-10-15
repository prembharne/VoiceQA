package app

import (
	"net/url"
	"strings"
	"voiceqa/companion/internal/core"
)

// Compile only the exact redundant example wrapper around an already supplied
// origin-bound reference. Unknown ids/fields and ambiguous tab scope stay invalid.
func normalizeCredentialWrappers(plan *core.Plan, profiles []AuthProfile) {
	for ci := range plan.Cases {
		c := &plan.Cases[ci]
		origin := plan.Origin
		if c.Page != "" && c.Page != "main" {
			origin = ""
			for _, p := range plan.Pages {
				if p.Alias == c.Page {
					origin = p.Origin
				}
			}
		}
		for si := range c.Steps {
			action := &c.Steps[si]
			if action.Operation == "navigate" {
				origin = ""
				if u, err := url.Parse(action.Value); err == nil {
					next := u.Scheme + "://" + u.Host
					known := next == plan.Origin
					for _, p := range plan.Pages {
						known = known || next == p.Origin
					}
					if known && core.AllowedURL(action.Value, next) {
						origin = next
					}
				}
			}
			if strings.HasSuffix(action.Operation, "_tab") {
				origin = ""
			}
			if action.Operation != "fill_secret" || origin == "" {
				continue
			}
			parts := strings.Split(action.Value, ":")
			if len(parts) != 3 || parts[0] != "ACTUAL_PROFILE_ID" {
				continue
			}
			for _, p := range profiles {
				if p.Origin == origin && p.ID == parts[1] && ((parts[2] == "username" && p.HasUsername) || (parts[2] == "password" && p.HasPassword)) {
					action.Value = parts[1] + ":" + parts[2]
				}
			}
		}
	}
}
