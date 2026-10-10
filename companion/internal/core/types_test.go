package core

import "testing"

func validPlan() Plan {
	return Plan{URL: "https://example.test/", Origin: "https://example.test", Viewports: []Viewport{{Width: 1440, Height: 900}}, Cases: []Case{{Name: "Cart", Steps: []Action{{Operation: "assert", Target: "#total", Assertion: &Assertion{Kind: "number", Expected: "24"}}}}}}
}
func TestRequireIndependentAssertion(t *testing.T) {
	p := validPlan()
	p.Cases[0].Steps = []Action{{Operation: "click", Target: "#submit"}}
	if ValidatePlan(p) == nil {
		t.Fatal("action-only plan accepted")
	}
}
func TestRejectCrossOriginNavigation(t *testing.T) {
	p := validPlan()
	p.Cases[0].Steps = append(p.Cases[0].Steps, Action{Operation: "navigate", Value: "https://other.test/"})
	if ValidatePlan(p) == nil {
		t.Fatal("cross-origin plan accepted")
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
