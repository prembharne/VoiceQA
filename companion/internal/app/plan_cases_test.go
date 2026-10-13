package app

import (
	"testing"
	"voiceqa/companion/internal/core"
)

func TestConsolidateExactDuplicateCasesWithoutDroppingIntentionalRepeats(t *testing.T) {
	c := core.Case{Name: "Preview", Steps: []core.Action{{Operation: "navigate", Value: "https://example.test/"}, {Operation: "assert", Target: "#total", Assertion: &core.Assertion{Kind: "number", Expected: "75"}}}}
	copy := c
	copy.Name = "Preview duplicate"
	if got := normalizeDraftCases([]core.Case{c, copy}, "Check the preview"); len(got) != 1 {
		t.Fatal("identical duplicate was retained", got)
	}
	if got := normalizeDraftCases([]core.Case{c, copy}, "Repeat the check twice"); len(got) != 2 {
		t.Fatal("intentional repetition removed", got)
	}
	copy.Page = "other"
	if got := normalizeDraftCases([]core.Case{c, copy}, "Check both pages"); len(got) != 2 {
		t.Fatal("different page scope merged", got)
	}
}
