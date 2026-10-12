package app

import (
	"strings"
	"voiceqa/companion/internal/core"
)

// Models often return browser-valid root-relative paths. Expand only those
// against the case's approved page origin; never guess hosts or repair schemes.
// Core validation still checks every expanded URL before a draft can be saved.
func normalizeDraftURLs(plan *core.Plan) {
	for ci := range plan.Cases {
		c := &plan.Cases[ci]
		origin := plan.Origin
		if c.Page != "" && c.Page != "main" {
			origin = ""
			for _, page := range plan.Pages {
				if page.Alias == c.Page {
					origin = page.Origin
					break
				}
			}
		}
		expand := func(raw string) string {
			if origin != "" && strings.HasPrefix(raw, "/") && !strings.HasPrefix(raw, "//") && !strings.Contains(raw, "\\") {
				return origin + raw
			}
			return raw
		}
		for ai := range c.Steps {
			a := &c.Steps[ai]
			// A browser navigation has no element target. Some compatible models
			// put its URL in target; compile this unambiguous representation before
			// scope validation, without changing the URL or approved origin.
			if a.Operation == "navigate" && a.Value == "" && (strings.HasPrefix(a.Target, "http://") || strings.HasPrefix(a.Target, "https://") || strings.HasPrefix(a.Target, "/")) {
				a.Value, a.Target = a.Target, ""
			}
			if a.Operation == "navigate" {
				a.Value = expand(a.Value)
			}
			// Once tab context changes, relative paths are ambiguous. Keep them
			// for validation/repair instead of assigning the wrong origin.
			if a.Operation == "open_tab" || a.Operation == "switch_tab" || a.Operation == "close_tab" {
				origin = ""
			}
		}
	}
}
