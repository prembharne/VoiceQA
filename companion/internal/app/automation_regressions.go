package app

import (
	"fmt"
	"strings"
	"voiceqa/companion/internal/core"
)

type automationRegression struct {
	ID                string      `json:"id"`
	Requirement       string      `json:"requirement"`
	Page              string      `json:"page"`
	URL               string      `json:"url"`
	PriorObservation  string      `json:"priorObservation"`
	FailedObservation string      `json:"failedObservation"`
	AfterActions      int         `json:"afterActions"`
	Action            core.Action `json:"action"`
	Actual            string      `json:"actual"`
}

// Require an observed correct value, then an incorrect value on the SAME
// document URL/page/target. Missing targets and initial unfinished states are
// not measured regressions. The late model audit must additionally judge
// whether the transition violates the user's request.
func automationRegressionCandidates(r *core.Run, checks []automationCheck) []automationRegression {
	candidates := []automationRegression{}
	for _, check := range checks {
		if check.Action.Assertion == nil || (check.Action.Assertion.Kind != "text" && check.Action.Assertion.Kind != "text_contains") {
			continue
		}
		good := map[string]string{}
		for _, snapshot := range r.Observations {
			obs, _ := snapshot["evidence"].(map[string]any)
			if stringField(obs, "page") != check.Page {
				continue
			}
			u := stringField(obs, "url")
			if u == "" {
				continue
			}
			rows, _ := obs["results"].([]any)
			for _, raw := range rows {
				row, ok := raw.(map[string]any)
				if !ok || stringField(row, "target") != check.Action.Target || row["visible"] != true {
					continue
				}
				actual, expected := stringField(row, "text"), check.Action.Assertion.Expected
				matches := actual == expected
				if check.Action.Assertion.Kind == "text_contains" {
					matches = strings.Contains(strings.ToLower(actual), strings.ToLower(expected))
				}
				if matches {
					good[u] = stringField(snapshot, "id")
					continue
				}
				if prior := good[u]; prior != "" && len(candidates) < 20 {
					after := 0
					switch n := snapshot["afterActions"].(type) {
					case int:
						after = n
					case float64:
						after = int(n)
					}
					candidates = append(candidates, automationRegression{ID: fmt.Sprintf("T%d", len(candidates)+1), Requirement: check.Requirement, Page: check.Page, URL: u, PriorObservation: prior, FailedObservation: stringField(snapshot, "id"), AfterActions: after, Action: check.Action, Actual: actual})
				}
			}
		}
	}
	return candidates
}

func recordAutomationRegression(r *core.Run, witness automationRegression) error {
	for _, step := range r.Steps {
		if step.Result["historical"] == true && step.Result["observationId"] == witness.FailedObservation && step.Action.Target == witness.Action.Target && step.Page == witness.Page {
			return nil
		}
	}
	action := witness.Action
	action.Label = "Recorded regression: " + trim(witness.Requirement, 180)
	now := core.Now()
	message := fmt.Sprintf("Recorded outcome regressed at %s after action %d: expected %q; observed %q. Later navigation does not erase this earlier discrepancy.", witness.FailedObservation, witness.AfterActions, action.Assertion.Expected, witness.Actual)
	viewport := "Recorded observation"
	if len(r.Plan.Viewports) > 0 {
		viewport = fmt.Sprintf("%dx%d", r.Plan.Viewports[0].Width, r.Plan.Viewports[0].Height)
	}
	r.Steps = append(r.Steps, core.Step{ID: core.ID(), Page: witness.Page, Viewport: viewport, Case: "Recorded temporal verification", Action: action, Status: "failed", StartedAt: now, CompletedAt: now, Error: message, Result: map[string]any{
		"historical": true, "passed": false, "kind": action.Assertion.Kind, "expected": action.Assertion.Expected, "actual": witness.Actual,
		"target": action.Target, "page": witness.Page, "url": witness.URL, "priorObservationId": witness.PriorObservation,
		"observationId": witness.FailedObservation, "observedAfterActions": witness.AfterActions,
	}})
	return &BrowserError{Code: "assertion_failed", Message: message}
}
