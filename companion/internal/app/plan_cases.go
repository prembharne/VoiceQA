package app

import (
	"encoding/json"
	"strings"
	"voiceqa/companion/internal/core"
)

// Exact duplicates do not add coverage and may repeat a mutation. Keep intentional
// repeated runs, and never remove repeated actions inside a case (idempotency tests).
func normalizeDraftCases(cases []core.Case, request string) []core.Case {
	text := strings.ToLower(request)
	for _, word := range []string{"repeat", "twice", "rerun", "stability", "multiple runs"} {
		if strings.Contains(text, word) {
			return cases
		}
	}
	seen := map[string]bool{}
	unique := make([]core.Case, 0, len(cases))
	for _, c := range cases {
		page := c.Page
		if page == "" {
			page = "main"
		}
		raw, err := json.Marshal(struct {
			Page  string
			Steps []core.Action
		}{page, c.Steps})
		if err != nil {
			unique = append(unique, c)
			continue
		}
		key := string(raw)
		if !seen[key] {
			seen[key] = true
			unique = append(unique, c)
		}
	}
	return unique
}
