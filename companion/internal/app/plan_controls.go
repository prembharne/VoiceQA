package app

import (
	"errors"
	"fmt"
	"strings"
	"voiceqa/companion/internal/core"
)

// Compile an equivalent input operation only from an exact observed control and
// actual option value. Navigation/tab boundaries prevent evidence being reused
// on a different document. Unknown controls and invalid options are untouched.
func normalizeDraftControls(cases []core.Case, obs map[string]any) error {
	var failures []error
	views := map[string]map[string]any{"main": obs}
	if additional, ok := obs["additionalPages"].(map[string]any); ok {
		for alias, value := range additional {
			if view, ok := value.(map[string]any); ok {
				views[alias] = view
			}
		}
	}
	for ci := range cases {
		alias := cases[ci].Page
		if alias == "" {
			alias = "main"
		}
		view := views[alias]
		current, _ := view["url"].(string)
		for si := range cases[ci].Steps {
			a := &cases[ci].Steps[si]
			switch a.Operation {
			case "navigate":
				current = a.Value
			case "open_tab":
				view = nil
				current = a.Value
			case "switch_tab":
				view = views[a.Target]
				current, _ = view["url"].(string)
			case "close_tab":
				view = views["main"]
				current, _ = view["url"].(string)
			}
			if view == nil || current != view["url"] {
				continue
			}
			controls, _ := view["controls"].([]any)
			for _, raw := range controls {
				control, ok := raw.(map[string]any)
				if !ok || control["role"] != "combobox" {
					continue
				}
				options, _ := control["options"].([]any)
				if len(options) == 0 {
					continue
				}
				for _, rawOption := range options {
					option, ok := rawOption.(map[string]any)
					if !ok {
						continue
					}
					if strings.HasPrefix(a.Target, "role:option|") && strings.EqualFold(strings.TrimPrefix(a.Target, "role:option|"), fmt.Sprint(option["label"])) {
						failures = append(failures, fmt.Errorf("case %d step %d: native option %q is not a clickable/visible page target; replace dropdown click/option wait/option click with select target=%q value=%q", ci+1, si+1, option["label"], control["target"], option["value"]))
					}
					if control["target"] != a.Target {
						continue
					}
					if a.Operation == "fill" && option["value"] == a.Value {
						a.Operation = "select"
					}
					if a.Assertion != nil && a.Assertion.Kind == "text" && a.Assertion.Expected == option["label"] && len(options) > 1 {
						failures = append(failures, fmt.Errorf("case %d step %d: native dropdown text contains all option labels; to verify selection use assertion kind=value expected=%q, not text=%q", ci+1, si+1, option["value"], option["label"]))
					}
				}
			}
		}
	}

	return errors.Join(failures...)
}
