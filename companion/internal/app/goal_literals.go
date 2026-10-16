package app

import (
	"regexp"
	"strings"
)

var exactContentDirective = regexp.MustCompile(`(?i)\b(?:exact(?:ly)?|verbatim)\b[^\n]{0,100}\b(?:text|source|code|content|value|json)\b[^\n.!?]{0,100}:\s*$`)

// Bind a model-formatted literal back to a unique, explicitly exact passage in
// the trusted request. Only whitespace may differ. Generated content, page
// evidence, ambiguous passages and ordinary values are never rewritten.
func requestedExactContent(request, proposed string) (string, bool) {
	if len(proposed) < 16 || len(proposed) > 4000 || strings.Contains(request, proposed) {
		return "", false
	}
	parts := strings.Fields(proposed)
	if len(parts) < 2 {
		return "", false
	}
	for i := range parts {
		parts[i] = regexp.QuoteMeta(parts[i])
	}
	pattern, err := regexp.Compile(strings.Join(parts, `[[:space:]]*`))
	if err != nil {
		return "", false
	}
	matches := pattern.FindAllStringIndex(request, 2)
	if len(matches) != 1 {
		return "", false
	}
	start, end := matches[0][0], matches[0][1]
	if !exactContentDirective.MatchString(request[max(0, start-220):start]) {
		return "", false
	}
	literal := request[start:end]
	return literal, literal != proposed
}
