package core

import (
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

var displayedAmount = regexp.MustCompile(`^\p{Sc}?\s*[+-]?(?:\d+(?:\.\d+)?|\d{1,3}(?:,\d{3})+\.\d+)\s*\p{Sc}?$`)

// A captured public value can be formatted for display. Only an explicitly
// numeric comparison may normalize a single amount; free text, multiple values,
// dates, ambiguous decimal separators and nonfinite numbers remain blocked.
func numericCapture(value string) (string, error) {
	text := strings.TrimSpace(value)
	if _, err := strconv.ParseFloat(text, 64); err != nil {
		if !displayedAmount.MatchString(text) {
			return "", errors.New("captured numeric expectation is not an unambiguous number or currency amount")
		}
		text = strings.Map(func(r rune) rune {
			if unicode.Is(unicode.Sc, r) || unicode.IsSpace(r) || r == ',' {
				return -1
			}
			return r
		}, text)
	}
	n, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return "", errors.New("captured numeric expectation must be finite")
	}
	return strconv.FormatFloat(n, 'g', -1, 64), nil
}
