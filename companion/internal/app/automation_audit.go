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

// Review coverage only after the live agent reaches outcomes. This is never an
// action plan, and does not dispatch browser tools or rewrite expectations.
func (a *App) auditLiveCompletion(ctx context.Context, r *core.Run, current map[string]any, checks []automationCheck) error {
	r.AgentPhase = "Checking the full request against recorded outcomes"
	a.update(r)
	if r.Status == "error" {
		return errors.New(r.Error)
	}
	history := r.Steps
	if len(history) > 12 {
		history = history[len(history)-12:]
	}
	regressions := automationRegressionCandidates(r, checks)
	selectedModel := r.AgentModel
	if selectedModel == "" {
		selectedModel = r.Plan.Model
	}
	raw, usage, err := a.aiClient(r.Plan.AIProvider).PlanStructured(ctx, a.keyFor(r.Plan.AIProvider), selectedModel, provider.AutomationAuditInstructions+"\n"+provider.AutomationTemporalAuditInstructions, map[string]any{"request": r.Plan.Request, "conversation": r.Plan.Conversation, "candidateChecks": checks, "potentialRegressions": regressions, "observedStateHistory": automationModelHistory(r.Observations), "readEvidence": r.ReadEvidence, "earlierEvidenceOmitted": r.EvidenceOmitted, "currentObservation": automationModelObservation(current), "publicCaptures": r.Values, "recentActions": agentPublicEvidence(map[string]any{"steps": history})["steps"]}, provider.AutomationAuditSchema(), nil)
	for key, n := range usage {
		r.Usage[key] += n
	}
	if err != nil {
		return agentResponseError(err, "outcome coverage review", true)
	}
	var audit struct {
		Covered              bool     `json:"covered"`
		Missing              []string `json:"missingRequirements"`
		Invalid              []string `json:"invalidExpectations"`
		Question             string   `json:"essentialQuestion"`
		ConfirmedRegressions []string `json:"confirmedRegressionIds"`
	}
	if err = json.Unmarshal(raw, &audit); err != nil {
		return err
	}
	for _, id := range audit.ConfirmedRegressions {
		found := false
		for _, witness := range regressions {
			if witness.ID == id {
				found = true
				break
			}
		}
		if !found {
			return errors.New("Outcome review cited an unknown temporal regression")
		}
	}
	if len(audit.ConfirmedRegressions) > 0 {
		for _, witness := range regressions {
			if witness.ID == audit.ConfirmedRegressions[0] {
				return recordAutomationRegression(r, witness)
			}
		}
	}
	if !audit.Covered || len(audit.Missing) > 0 || len(audit.Invalid) > 0 || audit.Question != "" {
		return fmt.Errorf("Completion is not yet supported for the whole request. Missing: %s. Unsupported expectations: %s. Essential question: %s. Add grounded outcome checks or continue with live tools; never change an expectation just to match an incorrect result.", recordedText(strings.Join(audit.Missing, "; "), 1500), recordedText(strings.Join(audit.Invalid, "; "), 1500), recordedText(audit.Question, 1000))
	}
	return nil
}
