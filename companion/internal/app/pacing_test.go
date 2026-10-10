package app

import (
	"context"
	"errors"
	"testing"
	"time"
	"voiceqa/companion/internal/core"
)

func TestGapCancellationNeverDispatchesNextAction(t *testing.T) {
	a := newTestApp(t)
	r := core.Run{ID: "paced-run", Status: "running", StepDelayMS: 4000, Steps: []core.Step{{Status: "passed"}}}
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(50*time.Millisecond, cancel)
	start := time.Now()
	_, e := a.beginStep(ctx, &r, core.Action{Operation: "click", Label: "Add mug"}, "Cart", "1440x900")
	if !errors.Is(e, context.Canceled) || time.Since(start) > time.Second || len(r.Steps) != 1 || r.NextStep != nil || r.NextStepAt != "" {
		t.Fatal("gap cancellation dispatched an action or stalled", e)
	}
}

func TestPaceSettingsDefaultAndBounds(t *testing.T) {
	a := newTestApp(t)
	if a.getSettings().StepDelayMS != 4000 {
		t.Fatal("step-by-step is not the default")
	}
	for _, delay := range []int{0, 3000, 4000, 5000, 2000, 6000, -1} {
		_, e := a.dispatch(message("settings.save", map[string]any{"stepDelayMs": delay}))
		valid := delay == 0 || (delay >= 3000 && delay <= 5000)
		if (e == nil) != valid {
			t.Fatalf("gap %d validation: %v", delay, e)
		}
	}
}
