package app

import (
	"encoding/json"
	"os"
	"testing"
	"voiceqa/companion/internal/core"
)

func quoteRun(quoted, receipt string) *core.Run {
	row := func(target, tag, text string) any {
		return map[string]any{"target": target, "tag": tag, "text": text, "visible": true}
	}
	view := func(id string, rows ...any) map[string]any {
		return map[string]any{"id": id, "evidence": map[string]any{"origin": "https://test.invalid", "page": "main", "results": rows}}
	}
	return &core.Run{Plan: core.Plan{Automation: &core.AutomationPolicy{Live: true}}, Observations: []map[string]any{view("O1", row("#calculated", "output", quoted)), view("O2", row("#receipt", "p", receipt)), view("O3", row("#receipt", "p", receipt))}}
}

func TestReceiptCannotAnchorItselfAcrossLaterCaptures(t *testing.T) {
	r := quoteRun("$410.00", "Confirmed total $435.00")
	a := core.Action{Operation: "assert", Target: "#receipt", Assertion: &core.Assertion{Kind: "text_contains", Expected: "$435.00"}}
	if validateQuotedOutcome(r, a, "Confirmed total $435.00") == nil {
		t.Fatal("Receipt was accepted as its own price oracle")
	}
	for _, kind := range []string{"text_contains", "number"} {
		b := core.Action{Operation: "assert", Target: "#receipt", Assertion: &core.Assertion{Kind: kind, Expected: "435.00"}}
		if validateQuotedOutcome(r, b, "$435.00") == nil {
			t.Fatal("Changing assertion syntax bypassed the quote conflict", kind)
		}
	}
	a.Assertion.Expected = "$410.00"
	if err := validateQuotedOutcome(r, a, "Confirmed total $435.00"); err != nil {
		t.Fatal("Correct defect-detecting assertion was blocked", err)
	}
	a.Assertion.Expected = "$435.00"
	r.Plan.Request = "The required final price is $435.00."
	if err := validateQuotedOutcome(r, a, "Confirmed total $435.00"); err != nil {
		t.Fatal("Explicit user requirement was discarded", err)
	}
}

func TestQuoteGuardDoesNotInventCurrencyEquivalenceOrAnUnobservedQuote(t *testing.T) {
	for _, quoted := range []string{"$435", "€410.00", "no quote", "$1.234,56"} {
		r := quoteRun(quoted, "Confirmed total $435.00")
		a := core.Action{Operation: "assert", Target: "#receipt", Assertion: &core.Assertion{Kind: "text_contains", Expected: "$435.00"}}
		if err := validateQuotedOutcome(r, a, "Confirmed total $435.00"); err != nil {
			t.Fatal("Equivalent, unrelated or unknown pricing became a claimed discrepancy", quoted, err)
		}
	}
}

func TestQuoteGuardRejectsTheRecordedQwenFalsePass(t *testing.T) {
	// This file is local actual-model evidence; CI does not depend on it.
	path := os.Getenv("VOICEQA_QUOTE_RECORDING")
	if path == "" {
		t.Skip("Set VOICEQA_QUOTE_RECORDING to check a local actual-model recording")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var run core.Run
	if err := json.Unmarshal(raw, &run); err != nil {
		t.Fatal(err)
	}
	rejected := false
	for _, step := range run.Steps {
		if step.Action.Operation == "assert" && step.Action.Target == "#receipt" && step.Action.Assertion != nil {
			rejected = rejected || validateQuotedOutcome(&run, step.Action, step.Action.Assertion.Expected) != nil
		}
	}
	if !rejected {
		t.Fatal("Actual recorded false-pass expectation remains accepted")
	}
}
