package app

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"voiceqa/companion/internal/core"
)

func TestProviderRecoveryRetainsActionsAndSharesFiniteBudget(t *testing.T) {
	s := goalTestSession(t)
	s.run.Steps = []core.Step{{ID: "existing", Status: "passed"}}
	for i := 0; i < 24; i++ {
		out, err := s.invokeRecovery(s.queueRecoveryFrom("provider_unavailable_before_dispatch", errors.New("Empty provider reply")))
		if err != nil || out.Stop || len(s.run.Steps) != 1 || s.lastRecovery["source"] != "provider_unavailable_before_dispatch" {
			t.Fatal("provider recovery replayed input or lost its source", err)
		}
	}
	if _, err := s.invokeRecovery(s.queueRecoveryFrom("provider_unavailable_before_dispatch", errors.New("still empty"))); err == nil {
		t.Fatal("provider recovery bypassed the run budget")
	}
}

func TestOnlyNewVerifiedProgressRefillsDiscovery(t *testing.T) {
	s := goalTestSession(t)
	s.stageReads, s.readCalls, s.recoveryStreak = 24, 24, 19
	click := core.Step{Status: "passed", Action: core.Action{Operation: "click"}, Result: map[string]any{"dispatched": true}}
	s.checkpoint(click)
	if s.remainingReads() != 0 || s.recoveryStreak != 19 {
		t.Fatal("dispatch became verified progress")
	}
	check := core.Step{ID: "checked", Page: "main", Status: "passed", Action: core.Action{Operation: "assert", Target: "#receipt", Assertion: &core.Assertion{Kind: "text", Expected: "Saved"}}, Result: map[string]any{"passed": true, "actual": "Saved"}}
	s.checkpoint(check)
	if s.remainingReads() != 24 || s.recoveryStreak != 0 || len(s.run.GoalProgress) != 1 {
		t.Fatal("verified outcome did not preserve progress/refill its stage", s.run.GoalProgress)
	}
	s.stageReads = 24
	s.checkpoint(check)
	if s.remainingReads() != 0 || len(s.run.GoalProgress) != 1 {
		t.Fatal("same assertion repeatedly refilled budget")
	}
	encoded, _ := json.Marshal(s.decisionSchema())
	if strings.Contains(string(encoded), "inspect_element") {
		t.Fatal("exhausted tool still advertised")
	}
	if automationReplayBlocked(core.Action{Operation: "capture_value", Target: "#editor", Value: "source"}, s.public, map[string]bool{automationStateFingerprint(core.Action{Operation: "capture_value", Target: "#editor", Value: "source"}, s.public): true}) {
		t.Fatal("read-only capture treated as a repeated mutation")
	}
	if len(s.run.GoalProgress) != 1 || s.run.GoalProgress[0]["stepId"] != "checked" {
		t.Fatal("progress lost provenance")
	}
}

func TestProgressNeverClearsFailedChecksOrTotalLimits(t *testing.T) {
	s := goalTestSession(t)
	s.run.Steps = []core.Step{{Status: "failed"}}
	s.readCalls = s.totalReadLimit()
	s.checkpoint(core.Step{ID: "later", Status: "passed", Action: core.Action{Operation: "assert", Target: "#other"}, Result: map[string]any{"passed": true, "actual": true}})
	if !automationHasFailures(s.run) || s.remainingReads() != 0 {
		t.Fatal("progress erased a failure or unlimited total reads became possible")
	}
	for i := 0; i < 185; i++ {
		s.event("test", "event")
	}
	e := s.event("goal_recovery", "latest")
	e["feedback"] = "actual reason"
	if len(s.run.AgentEvents) != 180 || s.run.AgentEvents[179]["feedback"] != "actual reason" {
		t.Fatal("event cap discarded final blocker")
	}
}
