package app

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"voiceqa/companion/internal/core"
)

func (s *automationSession) totalReadLimit() int {
	if s.run.Plan.Automation == nil {
		return 24
	}
	return max(24, min(120, 2*s.run.Plan.Automation.MaxActions))
}
func (s *automationSession) remainingReads() int {
	return max(0, min(automationReadBudget-s.stageReads, s.totalReadLimit()-s.readCalls))
}

// Only locally checked evidence can replenish a discovery window. A dispatched
// click, model label, visual DONE, or a repeated assertion is not new progress.
func (s *automationSession) checkpoint(step core.Step) {
	if step.Status != "passed" {
		return
	}
	kind := ""
	if step.Action.Operation == "assert" && step.Result["passed"] == true {
		kind = "assertion"
	}
	if step.Action.Operation == "fill" && step.Result["verified"] == true && step.Result["complete"] == true && step.Result["valueSource"] == "monaco-model" && len(stringField(step.Result, "contentHash")) == 64 {
		kind = "editor_readback"
	}
	if kind == "" {
		return
	}
	evidence := map[string]any{"kind": kind, "page": step.Page, "target": step.Action.Target, "assertion": step.Action.Assertion, "actual": step.Result["actual"], "contentHash": step.Result["contentHash"], "editorURI": step.Result["editorURI"]}
	encoded, _ := json.Marshal(evidence)
	id := fmt.Sprintf("%x", sha256.Sum256(encoded))
	if s.progressSeen == nil {
		s.progressSeen = map[string]bool{}
	}
	if s.progressSeen[id] {
		return
	}
	s.progressSeen[id] = true
	evidence["id"], evidence["stepId"], evidence["afterActions"], evidence["label"] = id, step.ID, len(s.run.Steps), recordedText(step.Action.Label, 300)
	if kind == "editor_readback" {
		evidence["verifiedInput"] = step.Action.Value
	}
	s.run.GoalProgress = append(s.run.GoalProgress, evidence)
	if len(s.run.GoalProgress) > 24 {
		s.run.GoalProgress = s.run.GoalProgress[len(s.run.GoalProgress)-24:]
	}
	s.stageReads, s.recoveryStreak, s.blockerReports = 0, 0, 0
	s.lastRecovery = nil
	s.event("verified_progress", kind)
}

func (s *automationSession) modelReads() []map[string]any {
	reads := s.run.ReadEvidence
	if len(reads) > 12 {
		reads = reads[len(reads)-12:]
	}
	for len(reads) > 1 {
		encoded, _ := json.Marshal(reads)
		if len(encoded) <= 16000 {
			break
		}
		reads = reads[1:]
	}
	return reads
}
