package core

import (
	"strings"
	"testing"
)

func TestDraftMetadataErrorIdentifiesTheActualRepair(t *testing.T) {
	p := validPlan()
	p.Cases[0].Goal = strings.Repeat("g", 501)
	err := ValidatePlan(p)
	if err == nil || !strings.Contains(err.Error(), "case 1 metadata") || !strings.Contains(err.Error(), "goal=501/500") || strings.Contains(err.Error(), "needs a name") {
		t.Fatal("Oversized goal reported as missing name/steps", err)
	}
}

func validPlan() Plan {
	return Plan{URL: "https://example.test/", Origin: "https://example.test", Viewports: []Viewport{{Width: 1440, Height: 900}}, Cases: []Case{{Name: "Cart", Steps: []Action{{Operation: "navigate", Value: "https://example.test/"}, {Operation: "assert", Target: "#total", Assertion: &Assertion{Kind: "number", Expected: "24"}}}}}}
}
func TestCurrentViewportDoesNotRequireEmulationBounds(t *testing.T) {
	p := validPlan()
	p.PreserveViewport = true
	p.Viewports = []Viewport{{Width: 2560, Height: 1440}}
	if err := ValidatePlan(p); err != nil {
		t.Fatal(err)
	}
	p.Viewports = append(p.Viewports, Viewport{Width: 390, Height: 844})
	if err := ValidatePlan(p); err == nil {
		t.Fatal("current viewport repeated at a mobile size")
	}
}
func TestRequireIndependentAssertion(t *testing.T) {
	p := validPlan()
	p.Cases[0].Steps = []Action{{Operation: "navigate", Value: p.URL}, {Operation: "click", Target: "#submit"}}
	if ValidatePlan(p) == nil {
		t.Fatal("action-only plan accepted")
	}
}

func TestRejectTargetlessElementChecksFromLiveDraft(t *testing.T) {
	p := validPlan()
	p.Cases[0].Steps[1].Target = ""
	if ValidatePlan(p) == nil {
		t.Fatal("targetless total check reached execution")
	}
	p.Cases[0].Steps[1].Target = "role:output"
	if ValidatePlan(p) == nil {
		t.Fatal("malformed role target reached execution")
	}
	p.Cases[0].Steps[1] = Action{Operation: "assert", Assertion: &Assertion{Kind: "url", Expected: p.URL}}
	if err := ValidatePlan(p); err != nil {
		t.Fatal("valid page URL check rejected", err)
	}
}
func TestRejectCrossOriginNavigation(t *testing.T) {
	p := validPlan()
	p.Cases[0].Steps = append(p.Cases[0].Steps, Action{Operation: "navigate", Value: "https://other.test/"})
	if ValidatePlan(p) == nil {
		t.Fatal("cross-origin plan accepted")
	}
}

func TestRejectChecksBeforeCaseReset(t *testing.T) {
	p := validPlan()
	p.Cases[0].Steps[0], p.Cases[0].Steps[1] = p.Cases[0].Steps[1], p.Cases[0].Steps[0]
	if ValidatePlan(p) == nil {
		t.Fatal("reversed case order was accepted")
	}
}
func TestRejectArbitraryCode(t *testing.T) {
	p := validPlan()
	p.Cases[0].Steps = append(p.Cases[0].Steps, Action{Operation: "eval", Value: "alert(1)"})
	if ValidatePlan(p) == nil {
		t.Fatal("arbitrary code accepted")
	}
}
func TestRejectUnansweredClarification(t *testing.T) {
	p := validPlan()
	p.Clarification = "What total?"
	if ValidatePlan(p) == nil {
		t.Fatal("unanswered clarification accepted")
	}
}
func TestOriginExactMatch(t *testing.T) {
	for _, u := range []string{"https://example.test.evil/", "javascript:alert(1)", "https://user:pass@example.test/"} {
		if AllowedURL(u, "https://example.test") {
			t.Fatalf("unsafe URL accepted: %s", u)
		}
	}
	if !AllowedURL("https://example.test/cart", "https://example.test") {
		t.Fatal("same-origin route rejected")
	}
}

func TestBooleanExpectationsRemainStrict(t *testing.T) {
	for _, kind := range []string{"visible", "enabled", "selected", "focus", "no_overflow"} {
		for _, expected := range []string{"true", "false", "yes", "error shown", "", "True"} {
			p := validPlan()
			p.Cases[0].Steps[1].Assertion = &Assertion{Kind: kind, Expected: expected}
			e := ValidatePlan(p)
			valid := expected == "true" || expected == "false"
			if (e == nil) != valid {
				t.Fatalf("%s expectation %q validation: %v", kind, expected, e)
			}
		}
	}
}

func TestCountExpectationsAreNonnegativeIntegers(t *testing.T) {
	for _, expected := range []string{"0", "2", "-1", "2.5", "many", ""} {
		p := validPlan()
		p.Cases[0].Steps[1].Assertion = &Assertion{Kind: "count", Expected: expected}
		e := ValidatePlan(p)
		valid := expected == "0" || expected == "2"
		if (e == nil) != valid {
			t.Fatalf("count expectation %q validation: %v", expected, e)
		}
	}
}
