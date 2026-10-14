package app

import (
	"net/url"
	"regexp"
	"strings"
	"voiceqa/companion/internal/core"
)

var aliasSeparator = regexp.MustCompile(`[^a-z0-9]+`)

// Compile a navigation argument only against an actually observed public link.
// The URL/origin permissions still pass through the shared scope validator.
func normalizeAutomationTab(action *core.Action, scope *core.Scope, observation map[string]any) {
	if action.Operation != "open_tab" {
		return
	}
	if strings.TrimSpace(action.Value) == "" {
		return
	}
	base, err := url.Parse(stringField(observation, "url"))
	if err != nil {
		return
	}
	value, err := url.Parse(action.Value)
	if err != nil {
		return
	}
	destination := base.ResolveReference(value).String()
	controls, _ := observation["controls"].([]any)
	label := ""
	best := 0
	ambiguous := false
	matchedURL := ""
	requestedAlias := action.Target
	for _, raw := range controls {
		row, ok := raw.(map[string]any)
		if !ok || stringField(row, "href") == "" || row["parameterizedLink"] == true {
			continue
		}
		score := 0
		alias := action.Target
		switch {
		case stringField(row, "href") == destination:
			score = 3
		case stringField(row, "href") == action.Target && core.AliasPattern.MatchString(action.Value):
			score, alias = 2, action.Value
		case stringField(row, "name") == action.Value:
			score = 1
		}
		if score == 0 || score < best {
			continue
		}
		if score == best {
			ambiguous = ambiguous || matchedURL != stringField(row, "href")
			continue
		}
		best, ambiguous = score, false
		matchedURL, label, requestedAlias = stringField(row, "href"), stringField(row, "name"), alias
	}
	if best == 0 || ambiguous {
		return
	}
	action.Value = matchedURL
	action.Target = requestedAlias
	if core.AliasPattern.MatchString(action.Target) && scope.Origins[action.Target] == "" {
		return
	}
	alias := strings.Trim(aliasSeparator.ReplaceAllString(strings.ToLower(label), "-"), "-")
	if alias == "" || alias[0] < 'a' || alias[0] > 'z' {
		alias = "page"
	}
	if len(alias) > 26 {
		alias = strings.TrimRight(alias[:26], "-")
	}
	candidate := alias
	for suffix := '2'; scope.Origins[candidate] != "" && suffix <= '9'; suffix++ {
		candidate = alias + "-" + string(suffix)
	}
	action.Target = candidate
}

func automationNavigationChoices(scope *core.Scope, observation map[string]any) []map[string]string {
	choices := []map[string]string{}
	controls, _ := observation["controls"].([]any)
	for _, raw := range controls {
		row, ok := raw.(map[string]any)
		if !ok || row["parameterizedLink"] == true {
			continue
		}
		href := stringField(row, "href")
		u, err := url.Parse(href)
		if err != nil || href == "" || !scope.Approved[u.Scheme+"://"+u.Host] {
			continue
		}
		action := core.Action{Operation: "open_tab", Value: href, Target: "role:link|" + stringField(row, "name")}
		normalizeAutomationTab(&action, scope, observation)
		choices = append(choices, map[string]string{"label": stringField(row, "name"), "url": action.Value, "suggestedNewAlias": action.Target})
		if len(choices) == 20 {
			break
		}
	}
	return choices
}

func stringField(value map[string]any, key string) string {
	text, _ := value[key].(string)
	return text
}
