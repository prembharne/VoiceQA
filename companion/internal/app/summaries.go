package app

import (
	"encoding/json"
	"voiceqa/companion/internal/core"
)

func trim(value string, n int) string {
	r := []rune(value)
	if len(r) > n {
		return string(r[:n]) + "…"
	}
	return value
}
func planSummary(p core.Plan) core.Plan {
	p.Cases = nil
	p.Dataset = nil
	p.Pages = nil
	p.Request = trim(p.Request, 200)
	p.Summary = trim(p.Summary, 300)
	p.Clarification = trim(p.Clarification, 200)
	return p
}
func (a *App) planList() (any, error) {
	raw, e := a.Store.List("plan")
	if e != nil {
		return nil, e
	}
	plans := []core.Plan{}
	for _, b := range raw {
		var p core.Plan
		if json.Unmarshal(b, &p) == nil {
			plans = append(plans, planSummary(p))
		}
	}
	return plans, nil
}
func (a *App) runList() (any, error) {
	raw, e := a.Store.List("run")
	if e != nil {
		return nil, e
	}
	runs := []core.Run{}
	for _, b := range raw {
		var r core.Run
		if json.Unmarshal(b, &r) == nil {
			r.Plan = planSummary(r.Plan)
			r.Steps = nil
			r.Values = nil
			r.SecurityFindings = nil
			r.Error = trim(r.Error, 200)
			runs = append(runs, r)
		}
	}
	return runs, nil
}

// Keep streaming messages bounded; complete details remain in local report exports.
func wireRun(r core.Run) core.Run {
	r.RecordedSteps = len(r.Steps)
	r.PassedSteps = 0
	r.FailedSteps = 0
	for _, s := range r.Steps {
		if s.Status == "passed" {
			r.PassedSteps++
		}
		if s.Status == "failed" {
			r.FailedSteps++
		}
	}
	b, _ := json.Marshal(r)
	if len(b) < 400*1024 {
		return r
	}
	r.Steps = append([]core.Step(nil), r.Steps...)
	for i := range r.Steps {
		old := r.Steps[i].Result
		if old == nil {
			continue
		}
		result := map[string]any{"detailsOmitted": "Large result; export HTML/JSON for complete evidence."}
		for _, key := range []string{"actual", "expected", "kind", "passed", "capture", "visual", "seriousCount", "rulePasses"} {
			if value, ok := old[key]; ok {
				result[key] = value
			}
		}
		if capture, ok := result["capture"].(map[string]any); ok {
			compact := map[string]any{}
			for _, key := range []string{"artifactId", "width", "height", "dpr", "platform", "browserVersion"} {
				if value, ok := capture[key]; ok {
					compact[key] = value
				}
			}
			result["capture"] = compact
		}
		r.Steps[i].Result = result
	}
	b, _ = json.Marshal(r)
	if len(b) > 400*1024 {
		r.Plan.Cases = nil
		for i := range r.Steps {
			r.Steps[i].Action.Value = trim(r.Steps[i].Action.Value, 200)
			if r.Steps[i].Action.HTTP != nil {
				check := *r.Steps[i].Action.HTTP
				check.Body = trim(check.Body, 200)
				r.Steps[i].Action.HTTP = &check
			}
			r.Steps[i].Error = trim(r.Steps[i].Error, 1000)
			if r.Steps[i].Action.Assertion != nil {
				check := *r.Steps[i].Action.Assertion
				check.Expected = trim(check.Expected, 200)
				r.Steps[i].Action.Assertion = &check
			}
		}
	}
	b, _ = json.Marshal(r)
	for len(b) > 400*1024 && len(r.Steps) > 20 {
		r.Steps = r.Steps[len(r.Steps)/2:]
		r.OmittedSteps = r.RecordedSteps - len(r.Steps)
		b, _ = json.Marshal(r)
	}
	return r
}
