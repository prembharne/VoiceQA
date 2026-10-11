package app

import (
	"strings"
	"testing"
	"voiceqa/companion/internal/core"
)

func TestExpectedDenialDoesNotMisdiagnoseLogicalSecurityFailure(t *testing.T) {
	r := &core.Run{Status: "failed", Steps: []core.Step{{ID: "failed", Status: "failed", Action: core.Action{Operation: "http_check"}, Result: map[string]any{"capture": map[string]any{"network": []any{map[string]any{"status": float64(401)}}}}}}}
	d := diagnose(r)
	if d.Category != "server_logic" {
		t.Fatal("an expected denial hid the actual server-logic failure", d)
	}
	r.Status = "cancelled"
	if diagnose(r).Category != "cancelled" {
		t.Fatal("cancellation treated as regression")
	}
}
func TestBugReportAndComparisonExposeReproductionAndRegression(t *testing.T) {
	a := newTestApp(t)
	before := core.Run{ID: "before", Plan: core.Plan{Origin: "https://app.test"}, Steps: []core.Step{{Case: "Authorization", Page: "main", Viewport: "1440x900", Iteration: 1, Action: core.Action{Operation: "http_check", Label: "Check denial"}, Status: "passed"}}}
	after := before
	after.ID = "after"
	after.Steps = append([]core.Step(nil), before.Steps...)
	after.Steps[0].Status = "failed"
	after.Steps[0].Error = "Expected 403; observed 200"
	after.Status = "failed"
	after.Diagnosis = diagnose(&after)
	_ = a.Store.Put("run", before.ID, before)
	_ = a.Store.Put("run", after.ID, after)
	result, e := a.compareRuns(message("run.compare", map[string]string{"before": "before", "after": "after"}))
	if e != nil {
		t.Fatal(e)
	}
	entries := result.(map[string]any)["entries"].([]comparison)
	if entries[0].Change != "regressed" {
		t.Fatal(entries)
	}
	text := bugReport(after)
	if !strings.Contains(text, "Expected 403; observed 200") || !strings.Contains(text, "Reproduction steps") {
		t.Fatal(text)
	}
}
func TestMissingPriceTargetIsNotAnObservedPriceMismatch(t *testing.T) {
	run := core.Run{Status: "failed", Steps: []core.Step{{ID: "review", Status: "failed", Action: core.Action{Operation: "assert", Assertion: &core.Assertion{Kind: "number", Expected: "120"}}, Result: map[string]any{"actual": "target missing"}}}}
	diagnosis := diagnose(&run)
	if diagnosis.Category != "target_or_evidence" || !strings.Contains(diagnosis.Summary, "not measured") {
		t.Fatal(diagnosis)
	}
}
func TestCurrentWidthCopyIsUnconfirmedAndDoesNotMutateTheOriginal(t *testing.T) {
	a := newTestApp(t)
	plan := core.Plan{ID: "responsive", Version: 1, Confirmed: true, URL: "https://example.test/", Origin: "https://example.test", Viewports: []core.Viewport{{Width: 1440, Height: 900}, {Width: 390, Height: 844}}, Cases: []core.Case{{Name: "Check", Steps: []core.Action{{Operation: "navigate", Value: "https://example.test/"}, {Operation: "assert", Target: "#total", Assertion: &core.Assertion{Kind: "number", Expected: "120"}}}}}}
	_ = a.Store.Put("plan", plan.ID, plan)
	result, err := a.dispatch(message("plan.fork", map[string]any{"id": plan.ID, "preserveViewport": true}))
	if err != nil {
		t.Fatal(err)
	}
	copy := result.(core.Plan)
	if !copy.PreserveViewport || len(copy.Viewports) != 1 || copy.Confirmed || copy.ID == plan.ID {
		t.Fatal(copy)
	}
	var original core.Plan
	_ = a.Store.Get("plan", plan.ID, &original)
	if original.PreserveViewport || len(original.Viewports) != 2 || !original.Confirmed {
		t.Fatal("saved plan changed")
	}
}

func TestRepeatedLabelsAndLegacyRowsCompareInOrder(t *testing.T) {
	a := newTestApp(t)
	step := core.Step{Case: "Cart", Page: "main", Viewport: "1440x900", Iteration: 1, Action: core.Action{Label: "Add mug"}, Status: "passed"}
	before := core.Run{ID: "repeat-before", Plan: core.Plan{Origin: "https://app.test"}, Steps: []core.Step{step, step, step}}
	before.Steps[0].Page = ""
	before.Steps[0].Iteration = 0
	before.Steps[1].Status = "failed"
	after := core.Run{ID: "repeat-after", Plan: before.Plan, Steps: []core.Step{step, step}}
	after.Steps[0].Status = "failed"
	_ = a.Store.Put("run", before.ID, before)
	_ = a.Store.Put("run", after.ID, after)
	out, err := a.compareRuns(message("run.compare", map[string]string{"before": before.ID, "after": after.ID}))
	if err != nil {
		t.Fatal(err)
	}
	entries := out.(map[string]any)["entries"].([]comparison)
	if len(entries) != 3 || entries[0].Change != "regressed" || entries[1].Change != "fixed" || entries[2].Change != "removed" {
		t.Fatal(entries)
	}
}
