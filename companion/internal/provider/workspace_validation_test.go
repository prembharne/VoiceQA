package provider

import (
	"strings"
	"testing"
	"voiceqa/companion/internal/core"
)

func TestWorkspaceDraftRejectsTheReportedFalseChecks(t *testing.T) {
	origin := "http://127.0.0.1:4173"
	plan := core.Plan{Origin: origin, Cases: []core.Case{{Name: "create", Steps: []core.Action{
		labAction("navigate", "", origin+"/", "Open"), labAction("click", "testid:new-order", "", "New order"), labAction("fill", "testid:customer-name", "Alice", "Customer"), labAction("fill", "testid:customer-email", "qa@relay.test", "Email"), labAction("click", "testid:wizard-next", "", "Next"), labAction("click", "testid:wizard-next", "", "Next"), labAction("click", "testid:wizard-next", "", "Submit"), labAssert("testid:review-total", "value", "120", "Review amount"),
	}}, {Name: "table", Steps: []core.Action{labAction("navigate", "", origin+"/", "Open"), labAssert("[data-testid=orders-rows] tr", "count", "5", "Rows"), labAction("fill", "testid:order-search", "Northstar", "Filter"), labAction("click", "testid:next-page", "", "Next page"), labAssert("testid:page-number", "text", "2", "Page")}}}}
	err := ValidateWorkspaceDraft(plan)
	if err == nil {
		t.Fatal("the reported plan was accepted")
	}
	for _, text := range []string{"reset=1", "before", "not an input value", "page size", "one page", "complete text"} {
		if !strings.Contains(err.Error(), text) {
			t.Fatal("omitted correction feedback", text, err)
		}
	}
}
func TestWorkspaceContractsAcceptSupportedFixtureWorkflows(t *testing.T) {
	origin := "http://127.0.0.1:4173"
	for _, p := range []core.Plan{WorkspaceDemoPlan(origin+"/", origin, "Test"), WorkspaceLayoutPlan(origin+"/app/layout", origin, "Test"), WorkspaceSecurityPlan(origin+"/app/security", origin, "Test", true), WorkspaceAuthPlan(origin+"/app/auth", origin, "Test", "relay")} {
		if err := ValidateWorkspaceDraft(p); err != nil {
			t.Fatal(p.Summary, err)
		}
	}
}
func TestReviewTotalAbsenceCheckDoesNotRequireReviewStage(t *testing.T) {
	plan := core.Plan{Cases: []core.Case{{Name: "Review removed", Steps: []core.Action{labAction("navigate", "", "http://127.0.0.1:4173/?reset=1", "Reset"), labAssert("testid:review-total", "hidden", "true", "Review is absent")}}}}
	if err := ValidateWorkspaceDraft(plan); err != nil {
		t.Fatal(err)
	}
	plan.Cases[0].Steps[1] = labAssert("testid:review-total", "number", "120", "Read review amount")
	if err := ValidateWorkspaceDraft(plan); err == nil {
		t.Fatal("unknown-stage amount check accepted")
	}
}
