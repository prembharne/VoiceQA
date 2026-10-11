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
