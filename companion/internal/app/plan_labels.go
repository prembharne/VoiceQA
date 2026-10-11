package app

import (
	"strings"
	"unicode"
	"voiceqa/companion/internal/core"
)

func meaningfulLabel(label string) bool {
	for _, r := range label {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return true
		}
	}
	return false
}

// Some providers use punctuation placeholders for unused fields. Keep the action
// unchanged while giving the operator a useful label for review and diagnosis.
func normalizeDraftLabels(cases []core.Case) {
	for ci := range cases {
		for ai := range cases[ci].Steps {
			a := &cases[ci].Steps[ai]
			if meaningfulLabel(a.Label) {
				continue
			}
			target := a.Target
			if strings.HasPrefix(target, "role:") && strings.Contains(target, "|") {
				target = strings.SplitN(target, "|", 2)[1]
			} else {
				for _, prefix := range []string{"testid:", "label:", "text:", "#"} {
					target = strings.TrimPrefix(target, prefix)
				}
				target = strings.NewReplacer("-", " ", "_", " ").Replace(target)
			}
			target = trim(target, 80)
			switch a.Operation {
			case "navigate":
				a.Label = "Open the starting page"
			case "click":
				a.Label = "Click " + target
			case "fill", "fill_secret", "fill_totp":
				a.Label = "Enter " + target
			case "select":
				a.Label = "Select " + target
			case "key":
				a.Label = "Press " + a.Value
			case "http_check":
				a.Label = "Verify the server response"
			case "assert":
				a.Label = "Verify " + target
			case "wait_for":
				a.Label = "Wait for " + target
			case "capture_value":
				a.Label = "Capture " + a.Value
			case "open_tab":
				a.Label = "Open " + target + " tab"
			case "switch_tab":
				a.Label = "Switch to " + target + " tab"
			case "close_tab":
				a.Label = "Close " + target + " tab"
			default:
				a.Label = "Run " + strings.ReplaceAll(a.Operation, "_", " ")
			}
		}
	}
}
