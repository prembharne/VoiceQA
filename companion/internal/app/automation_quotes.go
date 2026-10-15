package app

import (
	"fmt"
	"math/big"
	"regexp"
	"strings"
	"voiceqa/companion/internal/core"
)

var currencyLiteral = regexp.MustCompile(`([$€£₹])\s*([0-9][0-9,]*(?:\.[0-9]+)?)`)
var currencyDecimal = regexp.MustCompile(`^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]{1,2})?$`)

type observedMoney struct{ key, text, currency string }

func moneyLiterals(text string) []observedMoney {
	values := []observedMoney{}
	for _, match := range currencyLiteral.FindAllStringSubmatch(text, -1) {
		if !currencyDecimal.MatchString(match[2]) {
			continue // Unsupported locale/precision is unknown, never reinterpreted.
		}
		n, ok := new(big.Rat).SetString(strings.ReplaceAll(match[2], ",", ""))
		if ok {
			values = append(values, observedMoney{key: match[1] + n.RatString(), text: match[0], currency: match[1]})
		}
	}
	return values
}

// A final result cannot be its own price oracle when a single earlier HTML
// calculation output quoted another amount. This is a pre-dispatch conflict,
// not an automatic verdict or an expected-value rewrite. The actor must derive
// the expectation from earlier rules, or explain the missing business rule.
func validateQuotedOutcome(r *core.Run, action core.Action, actual string) error {
	if r.Plan.Automation == nil || !r.Plan.Automation.Live || action.Assertion == nil || (action.Assertion.Kind != "text" && action.Assertion.Kind != "text_contains" && action.Assertion.Kind != "number") {
		return nil
	}
	expected, observed := moneyLiterals(action.Assertion.Expected), moneyLiterals(actual)
	if len(expected) == 0 && len(observed) == 1 && currencyDecimal.MatchString(strings.TrimSpace(action.Assertion.Expected)) {
		expected = moneyLiterals(observed[0].currency + strings.TrimSpace(action.Assertion.Expected))
	}
	if len(expected) != 1 || len(observed) != 1 || expected[0].key != observed[0].key {
		return nil // A grounded disagreeing assertion must be allowed to fail.
	}
	for _, supplied := range moneyLiterals(r.Plan.Request) {
		if supplied.key == expected[0].key {
			return nil // An explicit user expectation is authoritative.
		}
	}
	if len(r.Observations) == 0 {
		return nil
	}
	current, _ := r.Observations[len(r.Observations)-1]["evidence"].(map[string]any)
	page, _ := current["page"].(string)
	origin, _ := current["origin"].(string)
	var quotation observedMoney
	quoteID := ""
	for _, record := range r.Observations {
		view, _ := record["evidence"].(map[string]any)
		if view["page"] != page || view["origin"] != origin {
			continue
		}
		results, _ := view["results"].([]any)
		present := false
		quotes := map[string]observedMoney{}
		for _, raw := range results {
			row, _ := raw.(map[string]any)
			present = present || row["target"] == action.Target
			if row["tag"] != "output" || row["visible"] != true {
				continue
			}
			text, _ := row["text"].(string)
			amounts := moneyLiterals(text)
			if len(amounts) == 1 {
				quotes[amounts[0].key] = amounts[0]
			}
		}
		if present {
			break // Never anchor a receipt to its own later captures/observations.
		}
		if len(quotes) == 1 {
			for _, value := range quotes {
				quotation, quoteID = value, stringField(record, "id")
			}
		} else if len(quotes) > 1 {
			quotation, quoteID = observedMoney{}, "" // Ambiguous is not a quote.
		}
	}
	if quoteID != "" && quotation.key != expected[0].key && quotation.currency == expected[0].currency {
		return fmt.Errorf("The expected amount %s copies the current result but conflicts with the earlier calculation output %s in %s. Derive the final amount from earlier pricing rules and requested inputs; do not use the receipt or a capture of it as its own oracle. If an additional charge is legitimate, its independent business rule is required. The controller has not rewritten the expectation or rerun a submission", expected[0].text, quotation.text, quoteID)
	}
	return nil
}
