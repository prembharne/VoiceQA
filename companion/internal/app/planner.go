package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/provider"
)

// Drafting never dispatches page mutations. A single retry repairs invalid output,
// using the same model, observations and deadline. Only a validated draft is saved.
func (a *App) draftPlan(ctx context.Context, request, url, origin string, responsive bool, obs map[string]any, pages ...core.Page) (core.Plan, error) {
	return a.draftConfiguredPlan(ctx, request, url, origin, responsive, obs, core.Plan{}, pages...)
}
func (a *App) draftConfiguredPlan(ctx context.Context, request, url, origin string, responsive bool, obs map[string]any, config core.Plan, pages ...core.Page) (core.Plan, error) {
	return a.draftPlanWithProgress(ctx, request, url, origin, responsive, obs, config, nil, pages...)
}
func planningError(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return &planningFailure{err, fmt.Sprintf("The AI provider did not finish building the plan within %d minutes. No tests were run. Try again, or choose another model from the chat composer.", int(provider.PlanningTimeout.Minutes()))}
	}
	if errors.Is(err, context.Canceled) {
		return &planningFailure{err, "Planning stopped. No tests were run."}
	}
	return err
}

// Preserve cancellation identity without exposing Go's transport error in chat.
type planningFailure struct {
	cause   error
	message string
}

func (e *planningFailure) Error() string { return e.message }
func (e *planningFailure) Unwrap() error { return e.cause }
func (a *App) draftPlanWithProgress(ctx context.Context, request, url, origin string, responsive bool, obs map[string]any, config core.Plan, progress func(provider.PlanProgress), pages ...core.Page) (core.Plan, error) {
	ctx, cancel := context.WithTimeout(ctx, provider.PlanningTimeout)
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
	input["coverageRule"] = "Create a concise, reviewable suite within actionBudget and apiCheckBudget. State any deferred or blocked requested coverage in the summary. Never claim full coverage from a partial suite. Missing optional credentials can be deferred explicitly while planning other discoverable workflows."
	input["scopeRule"] = "Only plan the workflows the user requested. actionBudget is a ceiling, not a target. A single authentication/MFA/CAPTCHA journey normally needs one case, with navigation first, login, readiness wait, identity assertion, operator checkpoint, and completion assertion. Do not add order, settings, security or other unrelated cases just because their controls are present."
	if obs["fixture"] == "voiceqa-shop-v1" && (strings.HasPrefix(origin, "http://127.0.0.1:") || strings.HasPrefix(origin, "http://localhost:")) {
		input["fixtureRequirements"] = provider.DemoPlan(url, origin, "").Cases
	}
	profiles, profileErr := a.authList()
	if profileErr != nil {
		return core.Plan{}, fmt.Errorf("Could not read saved test profiles: %w", profileErr)
	}
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
	if err := checkRequestedProfile(request, origin, allowedProfiles, pages...); err != nil {
		return core.Plan{}, err
	}
	if strings.HasPrefix(origin, "http://127.0.0.1:") || strings.HasPrefix(origin, "http://localhost:") {
		if obs["fixture"] == "voiceqa-workspace-v1" {
			input["fixtureRequirements"] = provider.WorkspaceRequirements(url, origin)
		}
		if obs["fixture"] == "voiceqa-workspace-layout-v1" {
			input["fixtureRequirements"] = provider.WorkspaceLayoutPlan(url, origin, request).Cases
		}
		if obs["fixture"] == "voiceqa-workspace-auth-v1" {
			profile := ""
			for _, entry := range allowedProfiles {
				if entry.Origin == origin && entry.HasUsername && entry.HasPassword && entry.HasTOTP {
					profile = entry.ID
					break
				}
			}
			input["fixtureRequirements"] = provider.WorkspaceAuthPlan(url, origin, request, profile).Cases
		}
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
			return core.Plan{}, planningError(e)
		}
		if progress != nil {
			phase := "waiting"
			if attempt > 0 {
				phase = "repairing"
			}
			progress(provider.PlanProgress{Phase: phase})
		}
		raw, usage, e := client.PlanStructured(ctx, key, s.Model, provider.PlanInstructions, input, provider.PlanSchema(pages...), progress)
		for name, tokens := range usage {
			totalUsage[name] += tokens
		}
		// Authentication, transport, refusal and incomplete-output errors are not retried.
		if e != nil {
			return core.Plan{}, planningError(e)
		}
		if progress != nil {
			progress(provider.PlanProgress{Phase: "validating"})
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
		normalizeDraftLabels(plan.Cases)
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
			normalizeDraftURLs(&plan)
			plan.Request = request
			plan.Model = s.Model
			plan.AIProvider = s.AIProvider
			plan.Usage = totalUsage
			plan.CreatedAt = core.Now()
			plan.Viewports = []core.Viewport{{Width: 1440, Height: 900}}
			if responsive {
				plan.Viewports = append(plan.Viewports, core.Viewport{Width: 390, Height: 844})
			} else {
				plan.PreserveViewport = true
				plan.Viewports = []core.Viewport{observedViewport(obs)}
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
				if e == nil && strings.HasPrefix(fmt.Sprint(obs["fixture"]), "voiceqa-workspace-") && (strings.HasPrefix(origin, "http://127.0.0.1:") || strings.HasPrefix(origin, "http://localhost:")) {
					e = provider.ValidateWorkspaceDraft(plan)
				}
			}
		}
		if e == nil {
			if err := ctx.Err(); err != nil {
				return core.Plan{}, planningError(err)
			}
			return plan, nil
		}
		input["validationError"] = e.Error()
		input["previousDraft"] = raw
		if attempt == 1 {
			return core.Plan{}, fmt.Errorf("AI plan was invalid after two attempts. Try again or choose another model from the chat composer. Details: %w", e)
		}
	}
	return core.Plan{}, fmt.Errorf("AI plan attempts exhausted")
}

// An explicitly requested saved profile is a local prerequisite, not a problem
// for the language model to reason about. Never reveal profile secret values.
func checkRequestedProfile(request, origin string, profiles []AuthProfile, pages ...core.Page) error {
	text := strings.ToLower(request)
	if !strings.Contains(text, "saved test profile") && !strings.Contains(text, "saved credential") {
		return nil
	}
	needsMFA := strings.Contains(text, "totp") || strings.Contains(text, "authenticator code")
	approved := map[string]bool{origin: true}
	for _, page := range pages {
		approved[page.Origin] = true
	}
	for _, p := range profiles {
		if approved[p.Origin] && p.HasUsername && p.HasPassword && (!needsMFA || p.HasTOTP) {
			return nil
		}
	}
	details := "username and password"
	if needsMFA {
		details += " and a TOTP seed for authenticator codes"
	}
	return fmt.Errorf("No ready saved test profile for %s. Open + → Test options → Test credentials & MFA and save the test account's %s. Then send this request again. No AI request was sent and no tests were run", origin, details)
}

func observedViewport(obs map[string]any) core.Viewport {
	v := core.Viewport{Width: 1440, Height: 900}
	if view, ok := obs["viewport"].(map[string]any); ok {
		if width, ok := view["width"].(float64); ok && width > 0 {
			v.Width = int(width)
		}
		if height, ok := view["height"].(float64); ok && height > 0 {
			v.Height = int(height)
		}
	}
	return v
}
