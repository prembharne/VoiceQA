package app

import (
	"encoding/json"
	"fmt"
	"strings"
	"voiceqa/companion/internal/core"
)

// Reject invented bearer sources before any reviewed plan can run. Evidence
// remains origin-bound; documentation can describe a source created by login.
func validateDraftAuthSources(plan core.Plan, observation map[string]any) error {
	evidence := map[string][]map[string]any{plan.Origin: {observation}}
	if additional, ok := observation["additionalPages"].(map[string]any); ok {
		for alias, raw := range additional {
			if view, ok := raw.(map[string]any); ok {
				for _, page := range plan.Pages {
					if page.Alias == alias {
						evidence[page.Origin] = append(evidence[page.Origin], view)
					}
				}
			}
		}
	}
	for ci, c := range plan.Cases {
		for si, a := range c.Steps {
			if a.HTTP == nil || a.HTTP.AuthSource == "" {
				continue
			}
			u := publicAgentURL(a.HTTP.URL)
			origin := ""
			for approved := range evidence {
				if strings.HasPrefix(u, approved+"/") {
					origin = approved
				}
			}
			known, provided := false, false
			for _, view := range evidence[origin] {
				if refs, exists := view["authSources"]; exists {
					provided = true
					raw, _ := json.Marshal(refs)
					var names []string
					_ = json.Unmarshal(raw, &names)
					for _, name := range names {
						known = known || name == a.HTTP.AuthSource
					}
				}
				if text, ok := view["text"].(string); ok {
					known = known || strings.Contains(text, a.HTTP.AuthSource)
				}
			}
			if provided && !known {
				return fmt.Errorf("case %d step %d: authSource is not observed or documented on its approved origin. Omit authSource/authPointer: HTTP already sends same-origin session cookies; never invent a bearer source", ci+1, si+1)
			}
		}
	}
	return nil
}
