package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/provider"
)

// Drafting never dispatches page mutations. A single retry repairs invalid output,
// using the same model, observations and deadline. Only a validated draft is saved.
func (a *App) draftPlan(ctx context.Context, request, url, origin string, responsive bool, obs map[string]any, pages ...core.Page) (core.Plan, error) {
	return a.draftConfiguredPlan(ctx, request, url, origin, responsive, obs, core.Plan{}, pages...)
}
func (a *App) draftConfiguredPlan(ctx context.Context, request, url, origin string, responsive bool, obs map[string]any, config core.Plan, pages ...core.Page) (core.Plan, error) {
	ctx, cancel := context.WithTimeout(ctx, 100*time.Second)
	defer cancel()
	s := a.getSettings()
	client := a.aiClient(s.AIProvider)
	key := a.keyFor(s.AIProvider)
	input := map[string]any{"request": request, "url": url, "approvedOrigin": origin, "observation": obs}
	input["mode"] = config.Mode
	input["testDataRows"] = config.Dataset
	input["securityAuthorized"] = config.SecurityAuthorized
	input["apiWritesAllowed"] = config.APIWritesAllowed
	rows := len(config.Dataset)
	if rows == 0 {
		rows = 1
	}
	views := 1
	if responsive {
		views = 2
	}
	limit := 50
	if rows > 1 {
		limit = 200
	}
	input["actionBudget"] = limit / (rows * views)
	input["apiCheckBudget"] = 20 / (rows * views)
	if obs["fixture"] == "voiceqa-shop-v1" && (strings.HasPrefix(origin, "http://127.0.0.1:") || strings.HasPrefix(origin, "http://localhost:")) {
		input["fixtureRequirements"] = provider.DemoPlan(url, origin, "").Cases
	}
	profiles, _ := a.authList()
	allowedProfiles := []AuthProfile{}
	for _, profile := range profiles {
		if profile.Origin == origin {
			allowedProfiles = append(allowedProfiles, profile)
		} else {
			for _, page := range pages {
				if page.Origin == profile.Origin {
					allowedProfiles = append(allowedProfiles, profile)
					break
				}
			}
		}
	}
	input["sharedPages"] = pages
	input["authProfiles"] = allowedProfiles
	if strings.HasPrefix(origin, "http://127.0.0.1:") || strings.HasPrefix(origin, "http://localhost:") {
		if obs["fixture"] == "voiceqa-security-v1" {
			input["fixtureRequirements"] = provider.SecurityDemoPlan(url, origin, request, config.SecurityAuthorized && config.Mode == "security").Cases
		}
		if obs["fixture"] == "voiceqa-workflow-v1" {
			input["fixtureRequirements"] = provider.WorkflowDemoPlan(url, origin, request).Cases
		}
	}
	if obs["fixture"] == "voiceqa-advanced-v1" && (strings.HasPrefix(origin, "http://127.0.0.1:") || strings.HasPrefix(origin, "http://localhost:")) {
		profile := ""
		for _, entry := range allowedProfiles {
			if entry.Origin == origin && entry.HasUsername && entry.HasPassword && entry.HasTOTP {
				profile = entry.ID
				break
			}
		}
		input["fixtureRequirements"] = provider.AdvancedDemoPlan(url, origin, request, profile).Cases
	}
	totalUsage := map[string]int{}
	for attempt := 0; attempt < 2; attempt++ {
		if e := ctx.Err(); e != nil {
			return core.Plan{}, e
		}
		raw, usage, e := client.StructuredWithBudget(ctx, key, s.Model, provider.PlanInstructions, input, provider.PlanSchema(pages...), 16000)
		for name, tokens := range usage {
			totalUsage[name] += tokens
		}
		// Authentication, transport, refusal and incomplete-output errors are not retried.
		if e != nil {
			return core.Plan{}, e
		}
		var draft struct {
			Summary string `json:"summary"`
			Result  struct {
				Type     string      `json:"type"`
				Cases    []core.Case `json:"cases"`
				Question string      `json:"question"`
			} `json:"result"`
		}
		e = json.Unmarshal(raw, &draft)
		plan := core.Plan{Summary: draft.Summary, Cases: draft.Result.Cases, Pages: pages}
		plan.Mode = config.Mode
		plan.APIWritesAllowed = config.APIWritesAllowed
		plan.SecurityAuthorized = config.SecurityAuthorized
		plan.Dataset = config.Dataset
		if e == nil {
			switch draft.Result.Type {
			case "plan":
				if draft.Result.Question != "" {
					e = fmt.Errorf("a plan result must not contain a question")
				}
			case "clarification":
				plan.Clarification = strings.TrimSpace(draft.Result.Question)
				plan.Cases = []core.Case{}
				if plan.Clarification == "" {
					e = fmt.Errorf("a clarification requires a specific question")
				}
			default:
				e = fmt.Errorf("result.type must be plan or clarification")
			}
		}
		if e == nil {
			plan.ID = core.ID()
			plan.Version = 1
			plan.URL = url
			plan.Origin = origin
			plan.Request = request
			plan.Model = s.Model
			plan.AIProvider = s.AIProvider
			plan.Usage = totalUsage
			plan.CreatedAt = core.Now()
			plan.Viewports = []core.Viewport{{Width: 1440, Height: 900}}
			if responsive {
				plan.Viewports = append(plan.Viewports, core.Viewport{Width: 390, Height: 844})
			}
			for i := range plan.Cases {
				plan.Cases[i].Source = "agent-proposed; requires confirmation"
				for j := range plan.Cases[i].Steps {
					if plan.Cases[i].Steps[j].Operation != "assert" && plan.Cases[i].Steps[j].Operation != "wait_for" {
						// Only explicit assert operations are checks. Remove unused
						// assertion metadata that some models attach to clicks/fills.
						plan.Cases[i].Steps[j].Assertion = nil
					}
				}
			}
			if plan.Clarification != "" {
				// A question is not a runnable plan. Discard any accompanying draft
				// actions rather than presenting invalid checks for confirmation.
				plan.Cases = []core.Case{}
			} else {
				e = core.ValidatePlan(plan)
			}
		}
		if e == nil {
			return plan, nil
		}
		input["validationError"] = e.Error()
		input["previousDraft"] = raw
		if attempt == 1 {
			return core.Plan{}, fmt.Errorf("AI plan was invalid after two attempts. Try again or choose another model in Setup. Details: %w", e)
		}
	}
	return core.Plan{}, fmt.Errorf("AI plan attempts exhausted")
}
