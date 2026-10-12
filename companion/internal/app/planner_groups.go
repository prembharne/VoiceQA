package app

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"unicode/utf8"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/provider"
)

type draftOptions struct {
	actionBudget    int
	originalRequest string
	scope           string
}

// Decompose explicitly requested bundled-demo requirements, not actions. Every
// workstream still calls the selected real model; no fixture plan is substituted.
// Three bounded calls share a deadline and are assembled only after validation.
func (a *App) draftPlanWithProgress(ctx context.Context, request, url, origin string, responsive bool, obs map[string]any, config core.Plan, progress func(provider.PlanProgress), pages ...core.Page) (core.Plan, error) {
	required := provider.WorkspaceCoverageRequirements(request)
	text := strings.ToLower(request)
	order := required["invoice"] != "" || required["totals"] != "" || required["confirmation"] != "" || required["tabs"] != ""
	eligible := obs["fixture"] == "voiceqa-workspace-v1" && (strings.HasPrefix(origin, "http://127.0.0.1:") || strings.HasPrefix(origin, "http://localhost:")) && config.Mode != "security" && order && required["validation"] != "" && required["settings"] != ""
	for _, word := range []string{"authentication", "mfa", "captcha", "login", "sign in", "security", "saved credential", "saved test profile"} {
		if strings.Contains(text, word) {
			eligible = false
		}
	}
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
	budget := limit / (rows * views)
	if !eligible || budget < 32 {
		return a.draftSinglePlanWithProgress(ctx, request, url, origin, responsive, obs, config, progress, draftOptions{}, pages...)
	}
	ctx, cancel := context.WithTimeout(ctx, provider.PlanningTimeout)
	defer cancel()
	orderRequest := "Test the order journey"
	if required["totals"] != "" {
		orderRequest += ", order calculations"
	}
	if required["confirmation"] != "" {
		orderRequest += ", submission and confirmation"
	}
	if required["invoice"] != "" {
		orderRequest += ", invoices"
	}
	if required["tabs"] != "" {
		orderRequest += ", multiple tabs"
	}
	groups := []struct {
		name, request string
		budget        int
	}{
		{"Order and invoice", orderRequest, budget * 52 / 100},
		{"Invalid inputs", "Test invalid inputs in the order wizard", budget * 24 / 100},
		{"Settings", "Test persistent settings across navigation", budget - budget*52/100 - budget*24/100},
	}
	results := make([]core.Plan, len(groups))
	failures := make([]error, len(groups))
	var workers sync.WaitGroup
	var firstFailure error
	var failedOnce sync.Once
	var progressMu sync.Mutex
	chars := make([]int, len(groups))
	for i, g := range groups {
		workers.Add(1)
		go func(i int, name, scope string, share int) {
			defer workers.Done()
			notify := func(p provider.PlanProgress) {
				if progress == nil {
					return
				}
				progressMu.Lock()
				defer progressMu.Unlock()
				chars[i] = p.ReceivedChars
				total := 0
				for _, n := range chars {
					total += n
				}
				progress(provider.PlanProgress{Phase: p.Phase, ReceivedChars: total})
			}
			results[i], failures[i] = a.draftSinglePlanWithProgress(ctx, scope+". Plan only this workstream; other requested workstreams are generated separately. Use at most three cases.", url, origin, responsive, obs, config, notify, draftOptions{actionBudget: share, originalRequest: request, scope: []string{"order", "validation", "settings"}[i]}, pages...)
			if failures[i] != nil {
				failures[i] = fmt.Errorf("%s workstream: %w", name, failures[i])
				failedOnce.Do(func() { firstFailure = failures[i]; cancel() })
			}
		}(i, g.name, g.request, g.budget)
	}
	workers.Wait()
	if firstFailure != nil {
		return core.Plan{}, firstFailure
	}
	for _, failure := range failures {
		if failure != nil {
			return core.Plan{}, failure
		}
	}
	out := results[0]
	out.ID = core.ID()
	out.Request = request
	out.Cases = nil
	out.Usage = map[string]int{}
	out.CreatedAt = core.Now()
	summaries := []string{}
	for i, p := range results {
		if p.Model != out.Model || p.AIProvider != out.AIProvider {
			return core.Plan{}, fmt.Errorf("model settings changed during planning; create a new plan")
		}
		if p.Clarification != "" {
			out.Cases = nil
			out.Clarification = p.Clarification
			out.Summary = p.Summary
			return out, nil
		}
		out.Cases = append(out.Cases, p.Cases...)
		for key, value := range p.Usage {
			out.Usage[key] += value
		}
		summary := p.Summary
		if len(summary) > 550 {
			summary = summary[:550]
			for !utf8.ValidString(summary) {
				summary = summary[:len(summary)-1]
			}
			summary += "…"
		}
		summaries = append(summaries, groups[i].name+": "+summary)
	}
	out.Summary = strings.Join(summaries, "\n\n")
	if err := core.ValidatePlan(out); err != nil {
		return core.Plan{}, fmt.Errorf("combined plan: %w", err)
	}
	if err := provider.ValidateWorkspaceCoverage(out, request); err != nil {
		return core.Plan{}, err
	}
	if err := ctx.Err(); err != nil {
		return core.Plan{}, planningError(err)
	}
	return out, nil
}
