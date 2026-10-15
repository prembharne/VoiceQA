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

type draftReviewSource struct {
	ID   string `json:"id"`
	Page string `json:"page"`
	Text string `json:"text"`
}
type draftReviewFinding struct {
	Location string `json:"location"`
	Source   string `json:"sourceId"`
	Reason   string `json:"reason"`
}
type draftReview struct {
	Verdict  string               `json:"verdict"`
	Findings []draftReviewFinding `json:"findings"`
}
type draftReviewCorrections struct{ message string }

func (e *draftReviewCorrections) Error() string { return e.message }

func reviewSources(request string, obs map[string]any) []draftReviewSource {
	sources := []draftReviewSource{{ID: "request", Page: "user", Text: request}}
	add := func(alias string, view map[string]any) {
		if text, ok := view["text"].(string); ok && strings.TrimSpace(text) != "" {
			for i, line := range strings.Split(text, "\n") {
				if strings.TrimSpace(line) != "" {
					sources = append(sources, draftReviewSource{ID: fmt.Sprintf("%s-text-%d", alias, i+1), Page: alias, Text: line})
				}
			}
		}
		fields := map[string]any{}
		for _, key := range []string{"url", "controls", "results", "csrfSources", "authSources", "challenges"} {
			if value, ok := view[key]; ok {
				fields[key] = value
			}
		}
		if len(fields) > 0 {
			raw, _ := json.Marshal(fields)
			sources = append(sources, draftReviewSource{ID: alias + "-controls", Page: alias, Text: string(raw)})
		}
	}
	add("main", obs)
	if pages, ok := obs["additionalPages"].(map[string]any); ok {
		for alias, raw := range pages {
			if view, ok := raw.(map[string]any); ok {
				add(alias, view)
			}
		}
	}
	if evidence, ok := obs["discoveredEvidence"]; ok {
		raw, _ := json.Marshal(evidence)
		if len(raw) < 64000 {
			sources = append(sources, draftReviewSource{ID: "discovery", Page: "read-only tools", Text: string(raw)})
		}
	}
	return sources
}

func validateDraftReview(review draftReview, plan core.Plan, sources []draftReviewSource) error {
	if review.Verdict != "ready" && review.Verdict != "revise" {
		return errors.New("Plan reviewer returned an invalid verdict")
	}
	if len(review.Findings) > 8 || (review.Verdict == "ready" && len(review.Findings) != 0) || (review.Verdict == "revise" && len(review.Findings) == 0) {
		return errors.New("Plan reviewer verdict does not match its findings")
	}
	for _, f := range review.Findings {
		validLocation := f.Location == "overall"
		for ci, c := range plan.Cases {
			for si := range c.Steps {
				validLocation = validLocation || f.Location == fmt.Sprintf("case:%d:step:%d", ci+1, si+1)
			}
		}
		if !validLocation || len([]rune(f.Reason)) > 4000 || strings.TrimSpace(f.Reason) == "" {
			return errors.New("Plan reviewer returned invalid locations or unbounded feedback")
		}
		grounded := false
		for _, source := range sources {
			if source.ID == f.Source && strings.TrimSpace(source.Text) != "" {
				grounded = true
			}
		}
		if !grounded {
			return errors.New("Plan reviewer cited an unknown evidence source; no tests were run")
		}
	}
	return nil
}

func (a *App) reviewSecurityDraft(ctx context.Context, client *provider.Client, key, model string, plan core.Plan, obs map[string]any, profiles []AuthProfile) (map[string]int, error) {
	sources := reviewSources(plan.Request, obs)
	publicProfiles := []AuthProfile{}
	for _, profile := range profiles {
		publicProfiles = append(publicProfiles, profile.publicMetadata())
	}
	profileJSON, _ := json.Marshal(publicProfiles)
	sources = append(sources, draftReviewSource{ID: "credential-profiles", Page: "local public metadata", Text: string(profileJSON)})
	contractJSON, _ := json.Marshal(provider.SemanticActionSchema())
	sources = append(sources, draftReviewSource{ID: "tool-contract", Page: "local action protocol", Text: string(contractJSON)})
	locations := []string{"overall"}
	cases := []map[string]any{}
	for ci, c := range plan.Cases {
		steps := []map[string]any{}
		for si, action := range c.Steps {
			reference := fmt.Sprintf("case:%d:step:%d", ci+1, si+1)
			locations = append(locations, reference)
			steps = append(steps, map[string]any{"reference": reference, "action": action})
		}
		cases = append(cases, map[string]any{"name": c.Name, "page": c.Page, "goal": c.Goal, "steps": steps})
	}
	input := map[string]any{"request": plan.Request, "sources": sources, "cases": cases, "clarification": plan.Clarification, "authProfiles": publicProfiles, "permissions": map[string]any{"mode": plan.Mode, "securityAuthorized": plan.SecurityAuthorized, "apiWritesAllowed": plan.APIWritesAllowed}, "approvedOrigin": plan.Origin, "sharedPages": plan.Pages}
	references := []string{}
	for _, p := range publicProfiles {
		if p.HasUsername {
			references = append(references, p.ID+":username")
		}
		if p.HasPassword {
			references = append(references, p.ID+":password")
		}
		if p.HasTOTP {
			references = append(references, p.ID)
		}
	}
	input["credentialReferences"] = references
	ids := []string{}
	for _, source := range sources {
		ids = append(ids, source.ID)
	}
	raw, usage, err := client.PlanStructured(ctx, key, model, provider.PlanReviewInstructions, input, provider.PlanReviewSchema(ids, locations), nil)
	if err != nil {
		return usage, fmt.Errorf("Security plan review did not complete; no tests were run: %w", err)
	}
	var review draftReview
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&review); err != nil {
		return usage, fmt.Errorf("Security plan review has an invalid response: %w", err)
	}
	// A correction annotation is not an executable target. Preserve an unknown
	// location as an overall request to revise, never as approval or retargeting.
	if review.Verdict == "revise" {
		for i := range review.Findings {
			known := false
			for _, location := range locations {
				known = known || review.Findings[i].Location == location
			}
			if !known {
				review.Findings[i].Location = "overall"
			}
		}
	}
	if err := validateDraftReview(review, plan, sources); err != nil {
		locations := []string{}
		maxReason := 0
		for i, f := range review.Findings {
			if i == 8 {
				break
			}
			locations = append(locations, trim(f.Location, 100))
			maxReason = max(maxReason, len([]rune(f.Reason)))
		}
		_ = a.Store.Put("plan_review_diagnostic", core.ID(), map[string]any{"error": recordedText(err.Error(), 500), "locations": locations, "findingCount": len(review.Findings), "maxReasonChars": maxReason, "usage": usage})
		return usage, err
	}
	// Persist only the source references and public quoted findings, not the raw
	// request, response bodies, filled values or credential material.
	excerpts := map[string]string{}
	for _, finding := range review.Findings {
		for _, source := range sources {
			if source.ID == finding.Source {
				excerpts[source.ID] = trim(source.Text, 1200)
			}
		}
	}
	if err := a.Store.Put("plan_review", core.ID(), map[string]any{"planId": plan.ID, "origin": plan.Origin, "localValidationPassed": true, "model": model, "verdict": review.Verdict, "findings": review.Findings, "sourceExcerpts": excerpts, "usage": usage}); err != nil {
		return usage, err
	}
	if review.Verdict == "revise" {
		reasons := []string{}
		for _, f := range review.Findings {
			reasons = append(reasons, fmt.Sprintf("%s: %s [source %s: %s]", f.Location, f.Reason, f.Source, excerpts[f.Source]))
		}
		return usage, &draftReviewCorrections{message: "Observed evidence review requires correction:\n" + strings.Join(reasons, "\n")}
	}
	return usage, nil
}
