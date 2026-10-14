package core

import "testing"

func automationPlan() Plan {
	return Plan{Mode: "automation", URL: "https://app.test/", Origin: "https://app.test", PreserveViewport: true, Viewports: []Viewport{{Width: 1280, Height: 720}}, Automation: &AutomationPolicy{MaxActions: 40, Criteria: []string{"A confirmed reservation shows the requested traveller and destination."}}}
}
func TestAutomationNeedsReviewedOutcomeCriteriaAndBoundedPolicy(t *testing.T) {
	p := automationPlan()
	if err := ValidatePlan(p); err != nil {
		t.Fatal(err)
	}
	p.Automation.Criteria = []string{"Click Next to advance"}
	if ValidatePlan(p) == nil {
		t.Fatal("interaction instruction accepted as final outcome")
	}
	p = automationPlan()
	p.Automation.Criteria = []string{"The browser viewport width stays at 1280 pixels"}
	if ValidatePlan(p) == nil {
		t.Fatal("execution policy accepted as application completion evidence")
	}
	p = automationPlan()
	p.Automation.MaxActions = 1000
	if ValidatePlan(p) == nil {
		t.Fatal("unbounded mission accepted")
	}
}

func TestLiveAutomationStartsWithoutPreplannedStepsOrCriteria(t *testing.T) {
	p := automationPlan()
	p.Automation.Live = true
	p.Automation.Criteria = nil
	if err := ValidatePlan(p); err != nil {
		t.Fatal(err)
	}
	p.Automation.Criteria = []string{"Precomputed outcome"}
	if ValidatePlan(p) == nil {
		t.Fatal("live mode accepted preplanned criteria")
	}
}
func TestAutomationActionCannotExpandOriginOrCloseUserPages(t *testing.T) {
	p := automationPlan()
	scope, _ := NewScope(p, "main")
	for _, action := range []Action{{Operation: "navigate", Value: "https://outside.test/"}, {Operation: "close_tab", Target: "main"}, {Operation: "evaluate", Value: "arbitrary code"}, {Operation: "navigate", Value: "https://app.test/delete"}} {
		if ValidateAutomationAction(p, scope.Clone(), action) == nil {
			t.Fatal("unsafe automation action accepted", action)
		}
	}
	if err := ValidateAutomationAction(p, scope.Clone(), Action{Operation: "fill", Target: "#name", Value: "QA Traveller"}); err != nil {
		t.Fatal(err)
	}
}
