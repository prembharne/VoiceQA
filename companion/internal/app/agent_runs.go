package app

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"voiceqa/companion/internal/core"
)

type DebugAssessment struct {
	Category   string   `json:"category"`
	Confidence string   `json:"confidence"`
	Facts      []string `json:"facts"`
	Hypotheses []string `json:"hypotheses"`
	NextChecks []string `json:"nextChecks"`
}

func validateRecordedRunScope(r core.Run, origin string, pages []core.Page) error {
	if r.Plan.Origin != origin || !core.AllowedURL(r.Plan.URL, origin) {
		return errors.New("Share the recorded run's original website before investigating it")
	}
	if r.Status == "running" || r.Status == "paused" || r.Status == "queued" {
		return errors.New("Finish or stop this run before investigating its recorded evidence")
	}
	approved := map[string]bool{origin: true}
	for _, page := range pages {
		approved[page.Origin] = true
	}
	for _, page := range r.Plan.Pages {
		if !approved[page.Origin] {
			return errors.New("Share every origin from this recorded run before including its evidence")
		}
	}
	return nil
}

var recordedURL = regexp.MustCompile(`https?://[^\s"<>]+`)

func recordedText(text string, limit int) string {
	return trim(recordedURL.ReplaceAllStringFunc(text, publicAgentURL), limit)
}

func recordedStepEvidence(s core.Step) map[string]any {
	action := map[string]any{"operation": s.Action.Operation, "target": s.Action.Target, "label": recordedText(s.Action.Label, 300)}
	if s.Action.TimeoutMS != 0 {
		action["timeoutMs"] = s.Action.TimeoutMS
	}
	if s.Action.Assertion != nil && (s.Action.Operation == "assert" || s.Action.Operation == "wait_for") {
		action["assertion"] = map[string]any{"kind": s.Action.Assertion.Kind, "expected": recordedText(s.Action.Assertion.Expected, 1000), "tolerance": s.Action.Assertion.Tolerance}
	}
	if s.Action.Operation == "navigate" || s.Action.Operation == "open_tab" {
		action["destination"] = publicAgentURL(s.Action.Value)
	}
	if s.Action.HTTP != nil {
		action["http"] = map[string]any{"method": s.Action.HTTP.Method, "url": publicAgentURL(s.Action.HTTP.URL), "expectedStatus": s.Action.HTTP.ExpectedStatus, "jsonPointer": s.Action.HTTP.JSONPointer, "expectedValue": recordedText(s.Action.HTTP.ExpectedValue, 1000)}
	}
	result := map[string]any{}
	for _, key := range []string{"actual", "expected", "kind", "passed", "status", "statusCode", "actualTruncated", "seriousCount", "rulePasses", "historical", "observationId", "priorObservationId", "observedAfterActions", "waitedMs", "timeoutMs", "polls", "missingPolls", "checkedTarget", "pending", "inputState", "verified", "complete", "contentHash", "valueSource", "length", "dispatched", "unchanged", "editorURI", "resolvedControl"} {
		if value, ok := s.Result[key]; ok {
			switch value.(type) {
			case string, bool, float64, int, int64, nil:
			default:
				continue // Never forward raw response objects as verdict scalars.
			}
			if text, ok := value.(string); ok {
				value = recordedText(text, 1000)
			}
			result[key] = value
		}
	}
	if capture, ok := s.Result["capture"].(map[string]any); ok {
		for _, key := range []string{"url", "width", "height", "network", "diagnostics"} {
			if value, ok := capture[key]; ok {
				if key == "network" {
					value = recordedEventMetadata(value, []string{"url", "method", "status", "durationMs", "resourceType", "at", "failed", "errorText"})
				} else if key == "diagnostics" {
					value = recordedEventMetadata(value, []string{"url", "type", "className", "line", "column", "at"})
				}
				result[key] = value
			}
		}
	}
	return agentPublicEvidence(map[string]any{"id": s.ID, "case": s.Case, "iteration": s.Iteration, "page": s.Page, "viewport": s.Viewport, "status": s.Status, "error": recordedText(s.Error, 1000), "startedAt": s.StartedAt, "completedAt": s.CompletedAt, "action": action, "result": result})
}

func recordedEventMetadata(value any, keys []string) []map[string]any {
	items, _ := value.([]any)
	if len(items) > 20 {
		items = items[len(items)-20:]
	}
	public := []map[string]any{}
	for _, raw := range items {
		row, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		copy := map[string]any{}
		for _, key := range keys {
			value, ok := row[key]
			if !ok {
				continue
			}
			switch v := value.(type) {
			case string:
				copy[key] = recordedText(v, 400)
			case bool, float64, int, int64:
				copy[key] = v
			}
		}
		public = append(public, copy)
	}
	return public
}

func recordedRunEvidence(r *core.Run, query string) (map[string]any, error) {
	if r == nil {
		return nil, errors.New("No recorded run was selected")
	}
	base := map[string]any{"historical": true, "runId": r.ID, "status": r.Status, "recordedAt": r.CompletedAt, "limitation": "Recorded evidence is a past observation. Current page state cannot retrospectively prove a root cause or reproduce an application defect."}
	switch {
	case query == "summary":
		base["goal"] = recordedText(r.Plan.Request, 2500)
		base["error"] = recordedText(r.Error, 1500)
		base["startedAt"] = r.StartedAt
		base["model"] = r.Plan.Model
		if r.AgentRuntime != "" {
			base["agentRuntime"] = r.AgentRuntime
			base["actualModel"] = r.AgentModel
			base["agentEvents"] = r.AgentEvents
		}
		base["mode"] = r.Plan.Mode
		base["stepCount"] = len(r.Steps)
		base["earlierEvidenceOmitted"] = r.EvidenceOmitted || len(r.Observations) == 0
		steps := []map[string]any{}
		for i, s := range r.Steps {
			if i >= 20 {
				break
			}
			steps = append(steps, map[string]any{"id": s.ID, "operation": s.Action.Operation, "status": s.Status, "label": recordedText(s.Action.Label, 160)})
		}
		base["steps"] = steps
		if len(r.Steps) > 20 {
			base["nextStepQuery"] = "steps:20"
		}
		refs := []map[string]any{}
		for _, obs := range slices.Concat(r.Observations, r.ReadEvidence) {
			ref := map[string]any{"id": obs["id"], "afterActions": obs["afterActions"]}
			if data, ok := obs["evidence"].(map[string]any); ok {
				ref["title"] = data["title"]
				ref["tool"] = data["tool"]
				if text, ok := data["text"].(string); ok {
					ref["preview"] = recordedText(text, 400)
				}
			}
			refs = append(refs, ref)
		}
		base["observations"] = refs
	case strings.HasPrefix(query, "steps:"):
		offset, err := strconv.Atoi(strings.TrimPrefix(query, "steps:"))
		if err != nil || offset < 0 || offset > len(r.Steps) {
			return nil, errors.New("Step-list offset is outside the selected run")
		}
		end := min(offset+20, len(r.Steps))
		refs := []map[string]any{}
		for _, s := range r.Steps[offset:end] {
			refs = append(refs, map[string]any{"id": s.ID, "operation": s.Action.Operation, "status": s.Status, "label": recordedText(s.Action.Label, 160)})
		}
		base["steps"] = refs
		if end < len(r.Steps) {
			base["nextStepQuery"] = fmt.Sprintf("steps:%d", end)
		}
	case query == "failures":
		failures := []map[string]any{}
		for _, s := range r.Steps {
			if s.Status != "passed" {
				if len(failures) == 8 {
					base["moreFailures"] = true
					break
				}
				// Return compact verdicts here; full diagnostics are available by
				// step ID without dropping an oversized multi-failure response.
				view := recordedStepEvidence(s)
				if result, ok := view["result"].(map[string]any); ok {
					delete(result, "network")
					delete(result, "diagnostics")
				}
				failures = append(failures, view)
			}
		}
		base["error"] = recordedText(r.Error, 1500)
		base["failures"] = failures
	case strings.HasPrefix(query, "step:"):
		id := strings.TrimPrefix(query, "step:")
		for _, s := range r.Steps {
			if s.ID == id {
				base["step"] = recordedStepEvidence(s)
				return base, nil
			}
		}
		return nil, errors.New("Step ID does not belong to the selected run")
	case strings.HasPrefix(query, "observation:"):
		id := strings.TrimPrefix(query, "observation:")
		for _, obs := range slices.Concat(r.Observations, r.ReadEvidence) {
			if obs["id"] == id {
				base["observation"] = obs
				return base, nil
			}
		}
		return nil, errors.New("Observation ID does not belong to the retained run evidence")
	default:
		return nil, errors.New("Read-run query must be summary, failures, steps:OFFSET, step:ID or observation:ID")
	}
	return base, nil
}

func validateDebugAssessment(d *DebugAssessment, evidence []AgentEvidence, sources []string) error {
	if d == nil || !slices.Contains([]string{"application_behavior", "expectation", "target_or_evidence", "transport", "scope_or_session", "unknown"}, d.Category) || !slices.Contains([]string{"observed", "hypothesis", "insufficient_evidence"}, d.Confidence) {
		return errors.New("Recorded-run answers require a valid evidence-qualified assessment")
	}
	citedRun := false
	for _, e := range evidence {
		for _, id := range sources {
			if e.ID == id && e.Tool == "read_run" && e.Error == "" && e.Result["historical"] == true {
				citedRun = true
			}
		}
	}
	if !citedRun {
		return errors.New("Debugging must read and cite the selected historical run")
	}
	for name, items := range map[string][]string{"facts": d.Facts, "hypotheses": d.Hypotheses, "nextChecks": d.NextChecks} {
		if len(items) > 8 {
			return fmt.Errorf("Too many debugging %s", name)
		}
		for _, item := range items {
			if strings.TrimSpace(item) == "" || len(item) > 1000 {
				return errors.New("Debug assessment contains empty or oversized entries")
			}
		}
	}
	if d.Confidence == "observed" && len(d.Facts) == 0 {
		return errors.New("Observed assessments require recorded facts")
	}
	return nil
}
