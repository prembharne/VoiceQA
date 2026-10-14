package app

import (
	"reflect"
	"strings"
	"testing"
	"voiceqa/companion/internal/core"
)

func TestPreparationMergePreservesActionsAndDoesNotInventChecks(t *testing.T) {
	setup := core.Case{Name: "Sign in", Steps: []core.Action{{Operation: "navigate", Value: "https://app.test/"}, {Operation: "fill_secret", Target: "#password", Value: "member:password"}}}
	checked := core.Case{Name: "Role restriction", Steps: []core.Action{{Operation: "navigate", Value: "https://app.test/"}, {Operation: "http_check", HTTP: &core.HTTPCheck{Method: "POST", URL: "https://app.test/approve", ExpectedStatus: 403}}}}
	merged := mergePlanPreparation([]core.Case{setup, checked})
	expected := append(append([]core.Action(nil), setup.Steps...), checked.Steps...)
	if len(merged) != 1 || !reflect.DeepEqual(merged[0].Steps, expected) {
		t.Fatal("preparation changed action order/contracts", merged)
	}
	checked.Page = "peer"
	if len(mergePlanPreparation([]core.Case{setup, checked})) != 2 {
		t.Fatal("different page scopes merged")
	}
	checked.Page = ""
	if len(mergePlanPreparation([]core.Case{checked, setup})) != 2 {
		t.Fatal("trailing unchecked work discarded or treated as verified")
	}
	setup.Steps = append(setup.Steps, core.Action{Operation: "open_tab", Target: "new-page", Value: "https://app.test/review"})
	if len(mergePlanPreparation([]core.Case{setup, checked})) != 2 {
		t.Fatal("case page-reset semantics changed by merging tab operations")
	}
}

func TestDraftFeedbackCollectsIndependentErrorsWithoutRewritingActions(t *testing.T) {
	p := core.Plan{Origin: "https://app.test", URL: "https://app.test/", Cases: []core.Case{{Steps: []core.Action{
		{Operation: "navigate", Value: "https://app.test/"},
		{Operation: "capture_value", Target: "meta[name=csrf-token]", Value: "csrf-token"},
		{Operation: "assert", Assertion: &core.Assertion{Kind: "number", Expected: "invalid"}},
	}}}}
	before := append([]core.Action(nil), p.Cases[0].Steps...)
	err := draftActionFeedback(p)
	if err == nil || !strings.Contains(err.Error(), "CSRF") || !strings.Contains(err.Error(), "nonempty element target") || !reflect.DeepEqual(before, p.Cases[0].Steps) {
		t.Fatalf("Missing combined feedback or mutated action: %v", err)
	}
}
