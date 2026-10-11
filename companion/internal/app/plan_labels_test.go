package app

import (
	"testing"
	"voiceqa/companion/internal/core"
)

func TestPunctuationLabelsBecomeUsefulWithoutChangingActions(t *testing.T) {
	cases := []core.Case{{Steps: []core.Action{{Operation: "click", Target: "testid:new-order", Label: ","}, {Operation: "fill", Target: "label:Contact email", Value: "qa@relay.test", Label: " "}, {Operation: "assert", Target: "testid:total", Label: "Verify the total"}}}}
	normalizeDraftLabels(cases)
	if cases[0].Steps[0].Label != "Click new order" || cases[0].Steps[1].Label != "Enter Contact email" || cases[0].Steps[2].Label != "Verify the total" {
		t.Fatal(cases)
	}
	if cases[0].Steps[1].Value != "qa@relay.test" || cases[0].Steps[0].Target != "testid:new-order" {
		t.Fatal("label normalization changed operational data")
	}
}
