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
func (a *App) draftSinglePlanWithProgress(ctx context.Context, request, url, origin string, responsive bool, obs map[string]any, config core.Plan, progress func(provider.PlanProgress), options draftOptions, pages ...core.Page) (core.Plan, error) {
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
	if options.actionBudget > 0 {
		input["actionBudget"] = options.actionBudget
		input["originalRequest"] = options.originalRequest
		input["workstreamRule"] = "The request field defines only this workstream. Cover its requested scope within actionBudget and at most three cases. Other workstreams from originalRequest are generated separately; do not add their actions here."
	}
	input["apiCheckBudget"] = 20 / (rows * views)
	input["coverageRule"] = "Create a concise, reviewable suite within actionBudget and apiCheckBudget. State any deferred or blocked requested coverage in the summary. Never claim full coverage from a partial suite. Missing optional credentials can be deferred explicitly while planning other discoverable workflows."
	input["scopeRule"] = "Only plan the workflows the user requested. actionBudget is a ceiling, not a target. Cover every explicitly requested discoverable workflow; do not replace user journeys with dashboard-only checks. Do not add unrelated cases just because their controls are present. Never invent a profile; an empty authProfiles list means no saved credentials are available."
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
	credentialReferences := []map[string]string{}
	for _, p := range allowedProfiles {
		if p.HasUsername {
			credentialReferences = append(credentialReferences, map[string]string{"origin": p.Origin, "operation": "fill_secret", "value": p.ID + ":username"})
		}
		if p.HasPassword {
			credentialReferences = append(credentialReferences, map[string]string{"origin": p.Origin, "operation": "fill_secret", "value": p.ID + ":password"})
		}
		if p.HasTOTP {
			credentialReferences = append(credentialReferences, map[string]string{"origin": p.Origin, "operation": "fill_totp", "value": p.ID})
		}
	}
	input["credentialReferences"] = credentialReferences
	fixtureTOTP := strings.HasPrefix(fmt.Sprint(obs["fixture"]), "voiceqa-workspace-") && (strings.HasPrefix(origin, "http://127.0.0.1:") || strings.HasPrefix(origin, "http://localhost:")) && strings.Contains(strings.ToLower(request), "mfa")
	if err := checkRequestedProfileWithTOTP(request, origin, allowedProfiles, fixtureTOTP, pages...); err != nil {
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
	startURL := url
	if requirements, ok := input["fixtureRequirements"].(map[string]any); ok {
		if options.scope != "" {
			input["workstream"] = options.scope
			delete(requirements, "authentication")
			delete(requirements, "security")
			delete(requirements, "orderTable")
			if options.scope == "settings" {
				delete(requirements, "orderWizard")
			} else {
				delete(requirements, "preferences")
			}
			if options.scope == "validation" {
				if wizard, ok := requirements["orderWizard"].(map[string]any); ok {
					delete(wizard, "serverVerification")
					delete(wizard, "invoice")
				}
			}
		}
		if resetURL, ok := requirements["resetURL"].(string); ok {
			startURL = resetURL
		}
		text := strings.ToLower(request)
		authRequested := strings.Contains(text, "authentication") || strings.Contains(text, "mfa") || strings.Contains(text, "captcha") || strings.Contains(text, "login") || strings.Contains(text, "sign in")
		otherRequested := strings.Contains(text, "order") || strings.Contains(text, "invoice") || strings.Contains(text, "settings") || strings.Contains(text, "security") || config.Mode == "security"
		if authRequested && !otherRequested {
			if auth, ok := requirements["authentication"].(map[string]any); ok {
				if reset, ok := auth["resetURL"].(string); ok {
					startURL = reset
				}
			}
			delete(requirements, "orderWizard")
			delete(requirements, "orderTable")
			delete(requirements, "preferences")
			delete(requirements, "security")
		} else if otherRequested && !authRequested {
			delete(requirements, "authentication")
		}
		if config.Mode != "security" {
			delete(requirements, "security")
		} else if security, ok := requirements["security"].(map[string]any); ok {
			if reset, ok := security["resetURL"].(string); ok {
				startURL = reset
			}
		}
	}
	input["navigationExample"] = map[string]any{"operation": "navigate", "target": "", "value": startURL, "label": "Open the starting page", "timeoutMs": 0, "assertion": nil, "http": nil}
	if strings.HasPrefix(fmt.Sprint(obs["fixture"]), "voiceqa-workspace-") {
		input["requiredCoverage"] = provider.WorkspaceCoverageRequirements(request)
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
		normalizeDraftWaits(plan.Cases)
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
				if options.actionBudget > 0 {
					actions := 0
					for _, c := range plan.Cases {
						actions += len(c.Steps)
					}
					if actions > options.actionBudget || len(plan.Cases) > 3 {
						e = errors.Join(e, fmt.Errorf("this workstream allows at most %d actions and three cases; compact only its required journeys", options.actionBudget))
					}
				}
				e = errors.Join(e, validateProfileReferences(plan, allowedProfiles))
				if strings.HasPrefix(fmt.Sprint(obs["fixture"]), "voiceqa-workspace-") && (strings.HasPrefix(origin, "http://127.0.0.1:") || strings.HasPrefix(origin, "http://localhost:")) {
					e = errors.Join(e, provider.ValidateWorkspaceDraft(plan), provider.ValidateWorkspaceCoverage(plan, request))
				}
			}
		}
		if a.DraftDiagnostic != nil {
			a.DraftDiagnostic(attempt+1, plan, e)
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

func validateProfileReferences(plan core.Plan, profiles []AuthProfile) error {
	var failures []error
	for ci, c := range plan.Cases {
		scope, err := core.NewScope(plan, c.Page)
		if err != nil {
			continue
		}
		for si, action := range c.Steps {
			if action.Operation == "fill_secret" || action.Operation == "fill_totp" {
				references := []string{action.Value}
				if strings.Contains(action.Value, "${") && len(plan.Dataset) > 0 {
					references = nil
					for _, row := range plan.Dataset {
						ref, err := core.Expand(action.Value, row, false)
						if err != nil {
							failures = append(failures, err)
							continue
						}
						references = append(references, ref)
					}
				}
				for _, reference := range references {
					parts := strings.Split(reference, ":")
					found := false
					var choices []string
					for _, profile := range profiles {
						if profile.Origin != scope.Origins[scope.Current] {
							continue
						}
						choices = append(choices, profile.ID)
						if profile.ID != parts[0] {
							continue
						}
						if action.Operation == "fill_totp" {
							found = profile.HasTOTP
						} else if len(parts) == 2 {
							found = parts[1] == "username" && profile.HasUsername || parts[1] == "password" && profile.HasPassword
						}
					}
					if !found {
						failures = append(failures, fmt.Errorf("case %d, step %d: credential reference %q is unavailable for this page. Use an actual supplied profile id from %v, with :username/:password for fill_secret or the id alone for fill_totp", ci+1, si+1, action.Value, choices))
					}
				}
				if len(references) > 0 {
					action.Value = references[0]
				}
			}
			if scope.Advance(action) != nil {
				break
			}
		}
	}
	return errors.Join(failures...)
}

// An explicitly requested saved profile is a local prerequisite, not a problem
// for the language model to reason about. Never reveal profile secret values.
func checkRequestedProfile(request, origin string, profiles []AuthProfile, pages ...core.Page) error {
	return checkRequestedProfileWithTOTP(request, origin, profiles, false, pages...)
}
func checkRequestedProfileWithTOTP(request, origin string, profiles []AuthProfile, requireTOTP bool, pages ...core.Page) error {
	text := strings.ToLower(request)
	if !strings.Contains(text, "saved test profile") && !strings.Contains(text, "saved credential") {
		return nil
	}
	needsMFA := requireTOTP || strings.Contains(text, "totp") || strings.Contains(text, "authenticator code")
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
