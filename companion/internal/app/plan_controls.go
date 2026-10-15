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
	byURL := map[string]map[string]any{}
	for _, view := range views {
		if raw, ok := view["url"].(string); ok {
			byURL[raw] = view
		}
	}
	if discovered, ok := obs["discoveredEvidence"].([]AgentEvidence); ok {
		for _, e := range discovered {
			if raw, ok := e.Result["url"].(string); ok && e.Result["controls"] != nil {
				byURL[raw] = e.Result
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
		aliasURLs := map[string]string{}
		for name, v := range views {
			raw, _ := v["url"].(string)
			aliasURLs[name] = raw
		}
		for si := range cases[ci].Steps {
			a := &cases[ci].Steps[si]
			switch a.Operation {
			case "navigate":
				current = a.Value
				view = byURL[current]
			case "open_tab":
				current = a.Value
				aliasURLs[a.Target] = current
				view = byURL[current]
			case "switch_tab":
				current = aliasURLs[a.Target]
				view = byURL[current]
			case "close_tab":
				view = views["main"]
				current, _ = view["url"].(string)
			}
			if view == nil || current != view["url"] {
				continue
			}
			if (a.Operation == "assert" || a.Operation == "wait_for") && strings.HasPrefix(a.Target, "role:heading|") {
				wanted := strings.TrimPrefix(a.Target, "role:heading|")
				results, _ := view["results"].([]any)
				candidates := []string{}
				for _, raw := range results {
					if row, ok := raw.(map[string]any); ok && strings.HasPrefix(fmt.Sprint(row["tag"]), "h") && strings.Contains(strings.ToLower(fmt.Sprint(row["text"])), strings.ToLower(wanted)) {
						if target, ok := row["target"].(string); ok && target != "" {
							candidates = append(candidates, target)
						}
					}
				}
				if len(candidates) == 1 {
					a.Target = candidates[0]
				}
			}
			controls, _ := view["controls"].([]any)
			for _, raw := range controls {
				control, ok := raw.(map[string]any)
				if !ok || control["role"] != "combobox" {
					continue
				}
				if control["target"] == a.Target && a.Operation == "select" && control["tag"] != nil && control["tag"] != "select" {
					failures = append(failures, errors.New("select requires a native SELECT. For this custom combobox, click its observed target, then choose an actual currently exposed option control"))
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
