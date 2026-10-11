package app

import (
	"encoding/json"
	"strings"
	"testing"
	"voiceqa/companion/internal/core"
)

func TestLargeWorkflowSnapshotsKeepCountsAndCompleteStoredEvidence(t *testing.T) {
	r := core.Run{Status: "running"}
	for i := 0; i < 410; i++ {
		r.Steps = append(r.Steps, core.Step{Status: "passed", Case: strings.Repeat("c", 100), Action: core.Action{Operation: "assert", Label: strings.Repeat("l", 300), Assertion: &core.Assertion{Kind: "text", Expected: strings.Repeat("e", 2000)}}, Result: map[string]any{"actual": strings.Repeat("a", 2000), "expected": strings.Repeat("e", 2000), "capture": map[string]any{"artifactId": "opaque", "network": strings.Repeat("n", 5000)}}})
	}
	wire := wireRun(r)
	b, _ := json.Marshal(wire)
	if len(b) > 400*1024 || wire.RecordedSteps != 410 || wire.PassedSteps != 410 || wire.OmittedSteps == 0 {
		t.Fatal("snapshot bounds or counts failed", len(b), wire.RecordedSteps, wire.OmittedSteps)
	}
	if len(r.Steps) != 410 || len(r.Steps[0].Action.Assertion.Expected) != 2000 {
		t.Fatal("stream compaction mutated complete evidence")
	}
}
