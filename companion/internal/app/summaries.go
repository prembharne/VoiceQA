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
			r.Error = trim(r.Error, 200)
			runs = append(runs, r)
		}
	}
	return runs, nil
}

// Keep streaming messages bounded; complete details remain in local report exports.
func wireRun(r core.Run) core.Run {
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
		r.Steps[i].Result = result
	}
	b, _ = json.Marshal(r)
	if len(b) > 400*1024 {
		r.Plan.Cases = nil
		for i := range r.Steps {
			r.Steps[i].Action.Value = trim(r.Steps[i].Action.Value, 200)
			r.Steps[i].Error = trim(r.Steps[i].Error, 1000)
		}
	}
	return r
}
