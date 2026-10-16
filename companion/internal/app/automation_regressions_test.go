package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"voiceqa/companion/internal/core"
)

func TestTemporalWitnessRequiresSameDocumentAndPreviouslyCorrectResult(t *testing.T) {
	check := automationCheck{Page: "main", Requirement: "Details remain correct", Action: core.Action{Operation: "assert", Target: "#summary", Assertion: &core.Assertion{Kind: "text_contains", Expected: "Aurora"}}}
	snapshot := func(id, page, url, text string, after int) map[string]any {
		return map[string]any{"id": id, "afterActions": after, "evidence": map[string]any{"page": page, "url": url, "results": []any{map[string]any{"target": "#summary", "text": text, "visible": true}}}}
	}
	r := &core.Run{Observations: []map[string]any{
		snapshot("O0", "main", "https://app.test/", "No project yet", 0),
		snapshot("O4", "main", "https://app.test/", "Aurora", 4),
		snapshot("O5", "main", "https://app.test/other", "Other page", 5),
		snapshot("O6", "peer", "https://app.test/", "Other tab", 6),
		snapshot("O8", "main", "https://app.test/", "Details unavailable", 8),
		snapshot("O9", "main", "https://app.test/", "Aurora", 9),
	}}
	witnesses := automationRegressionCandidates(r, []automationCheck{check})
	if len(witnesses) != 1 || witnesses[0].PriorObservation != "O4" || witnesses[0].FailedObservation != "O8" || witnesses[0].AfterActions != 8 {
		t.Fatal("initial state, other page or recovery changed witness", witnesses)
	}
	_ = recordAutomationRegression(r, witnesses[0])
	if len(r.Steps) != 1 || r.Steps[0].Status != "failed" || r.Steps[0].Result["historical"] != true || r.Steps[0].Result["actual"] != "Details unavailable" {
		t.Fatal("historical discrepancy lost", r.Steps)
	}
}

func TestRecordedRegressionCannotBypassMissingGoalCoverage(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("OPENAI_API_KEY", "fixture-key")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		audit := `{"covered":false,"missingRequirements":["remaining requested result"],"invalidExpectations":[],"essentialQuestion":"","confirmedRegressionIds":["T1"]}`
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "completed", "output": []any{map[string]any{"content": []any{map[string]any{"type": "output_text", "text": audit}}}}})
	}))
	defer server.Close()
	a.Provider.BaseURL = server.URL
	r := &core.Run{ID: core.ID(), Status: "running", Usage: map[string]int{}, Plan: core.Plan{AIProvider: "openai", Model: "gpt-5.6-sol"}}
	for i, text := range []string{"Ready", "Archived"} {
		r.Observations = append(r.Observations, map[string]any{"id": []string{"O0", "O1"}[i], "evidence": map[string]any{"page": "main", "url": "https://app.test/", "results": []any{map[string]any{"target": "#status", "visible": true, "text": text}}}})
	}
	checks := []automationCheck{{Page: "main", Requirement: "Status persists", Action: core.Action{Operation: "assert", Target: "#status", Assertion: &core.Assertion{Kind: "text", Expected: "Ready"}}}}
	_ = recordAutomationRegression(r, automationRegressionCandidates(r, checks)[0])
	err := a.auditLiveCompletion(context.Background(), r, map[string]any{}, checks)
	if err == nil || !strings.Contains(err.Error(), "remaining requested result") || len(r.Steps) != 1 || r.Steps[0].Status != "failed" {
		t.Fatal("deduplicated defect bypassed unfinished goal or was erased", err, r.Steps)
	}
}
