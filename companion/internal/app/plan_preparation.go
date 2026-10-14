package app

import "voiceqa/companion/internal/core"

// Preparation is part of the following test, not an independently passed test.
// Preserve all actions/order. Do not add or weaken assertions, merge page scopes,
// discard trailing unchecked work, or change execution permissions.
func mergePlanPreparation(cases []core.Case) []core.Case {
	out := []core.Case{}
	var pending *core.Case
	page := func(c core.Case) string {
		if c.Page == "" {
			return "main"
		}
		return c.Page
	}
	for _, c := range cases {
		if pending != nil {
			stationary := true
			for _, action := range pending.Steps {
				if action.Operation == "open_tab" || action.Operation == "switch_tab" || action.Operation == "close_tab" {
					stationary = false
				}
			}
			if stationary && page(*pending) == page(c) && len(c.Steps) > 0 && c.Steps[0].Operation == "navigate" {
				c.Steps = append(append([]core.Action(nil), pending.Steps...), c.Steps...)
				c.Goal = trim("Preparation: "+pending.Name+". "+c.Goal, 500)
			} else {
				out = append(out, *pending)
			}
			pending = nil
		}
		checked := false
		for _, action := range c.Steps {
			if action.Operation == "assert" || action.Operation == "http_check" {
				checked = true
			}
		}
		if checked {
			out = append(out, c)
		} else {
			copy := c
			pending = &copy
		}
	}
	if pending != nil {
		out = append(out, *pending)
	}
	return out
}
