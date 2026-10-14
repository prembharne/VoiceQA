package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"voiceqa/companion/internal/core"
)

func TestRecordedInvestigationRejectsUnsharedOriginsAndActiveRuns(t *testing.T) {
	r := core.Run{Status: "failed", Plan: core.Plan{Origin: "https://app.test", URL: "https://app.test/", Pages: []core.Page{{Alias: "billing", Origin: "https://billing.test", URL: "https://billing.test/"}}}}
	if validateRecordedRunScope(r, "https://other.test", nil) == nil || validateRecordedRunScope(r, "https://app.test", nil) == nil {
		t.Fatal("historical evidence escaped current approved origins")
	}
	pages := r.Plan.Pages
	if err := validateRecordedRunScope(r, r.Plan.Origin, pages); err != nil {
		t.Fatal(err)
	}
	r.Status = "running"
	if validateRecordedRunScope(r, r.Plan.Origin, pages) == nil {
		t.Fatal("changing active run accepted as fixed historical evidence")
	}
}

func TestRejectedDebugAnswerCannotLeakThroughLaterClarification(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("OPENAI_API_KEY", "fixture-key")
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var result any
		switch calls {
		case 1:
			result = map[string]any{"type": "tool", "name": "read_run", "args": map[string]string{"page": "main", "target": "", "url": "", "query": "summary"}}
		case 2:
			result = map[string]any{"type": "answer", "answer": "Rejected unsupported application defect claim", "sources": []string{"E1"}, "assessment": DebugAssessment{Category: "application_behavior", Confidence: "observed", Facts: []string{"No measured failed check"}}}
		default:
			result = map[string]any{"type": "clarification", "question": "Which business rule is required?"}
		}
		raw, _ := json.Marshal(map[string]any{"result": result})
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "completed", "output": []any{map[string]any{"content": []any{map[string]any{"type": "output_text", "text": string(raw)}}}}})
	}))
	defer server.Close()
	a.Provider.BaseURL = server.URL
	recorded := &core.Run{ID: "record", Status: "blocked", Plan: core.Plan{Origin: "https://app.test", URL: "https://app.test/"}, Error: "Malformed selector"}
	answer, err := a.investigateWithRun(context.Background(), "Explain this record", "https://app.test", nil, map[string]any{"url": "https://app.test/"}, nil, false, "request", recorded)
	if err != nil || answer.Answer != "" || len(answer.Sources) != 0 || answer.Assessment != nil || answer.Clarification == "" {
		t.Fatal("rejected answer escaped through clarification", err, answer)
	}
}

func TestRecordedTimelinePagesLongRunsWithoutDroppingItsIndex(t *testing.T) {
	r := &core.Run{ID: "long", Status: "failed"}
	for i := 0; i < 500; i++ {
		r.Steps = append(r.Steps, core.Step{ID: fmt.Sprintf("step-%d", i), Status: "passed", Action: core.Action{Operation: "click", Label: strings.Repeat("x", 300)}})
	}
	view, err := recordedRunEvidence(r, "summary")
	if err != nil {
		t.Fatal(err)
	}
	public := agentPublicEvidence(view)
	if public["nextStepQuery"] != "steps:20" || len(public["steps"].([]any)) != 20 {
		t.Fatal("long-run index was dropped", public)
	}
	view, err = recordedRunEvidence(r, "steps:480")
	if err != nil || len(view["steps"].([]map[string]any)) != 20 {
		t.Fatal("last timeline page unavailable", err)
	}
	if _, err = recordedRunEvidence(r, "steps:-1"); err == nil {
		t.Fatal("negative cursor accepted")
	}
}

func TestRecordedEvidenceExcludesInputsBodiesSecretsAndPrivateURLs(t *testing.T) {
	r := &core.Run{ID: "selected", Status: "failed", Steps: []core.Step{
		{ID: "secret", Status: "passed", Action: core.Action{Operation: "fill_secret", Value: "raw-test-password"}, Result: map[string]any{"value": "raw-test-password"}},
		{ID: "http", Status: "failed", Action: core.Action{Operation: "http_check", HTTP: &core.HTTPCheck{URL: "https://app.test/api?token=private-token", Body: `{"password":"raw-test-password"}`, ExpectedStatus: 403}}, Result: map[string]any{"actual": "200", "expected": "403", "capture": map[string]any{"url": "https://app.test/?token=private-token", "artifactId": "private-artifact"}}},
	}}
	for _, query := range []string{"step:secret", "step:http", "failures"} {
		view, err := recordedRunEvidence(r, query)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(view)
		if strings.Contains(string(raw), "raw-test-password") || strings.Contains(string(raw), "private-token") || strings.Contains(string(raw), "private-artifact") {
			t.Fatal("private recorded data exposed", string(raw))
		}
	}
	for _, query := range []string{"step:other-run-id", "observation:other-run", "execute", "file:C:/secrets"} {
		if _, err := recordedRunEvidence(r, query); err == nil {
			t.Fatal("arbitrary evidence query accepted", query)
		}
	}
}

func TestDebugAssessmentRequiresExactClassificationAndCitedHistoricalEvidence(t *testing.T) {
	d := &DebugAssessment{Category: "application_behavior", Confidence: "observed", Facts: []string{"Expected 410; observed 435"}}
	evidence := []AgentEvidence{{ID: "E1", Tool: "read_run", Result: map[string]any{"historical": true}}}
	if err := validateDebugAssessment(d, evidence, []string{"E1"}); err != nil {
		t.Fatal(err)
	}
	if validateDebugAssessment(d, evidence, []string{"E0"}) == nil {
		t.Fatal("uncited recorded evidence accepted")
	}
	d.Category = "application_behavior|expectation"
	if validateDebugAssessment(d, evidence, []string{"E1"}) == nil {
		t.Fatal("combined category bypassed enum")
	}
	d.Category = "unknown"
	d.Facts = nil
	if validateDebugAssessment(d, evidence, []string{"E1"}) == nil {
		t.Fatal("observed claim without facts accepted")
	}
}
