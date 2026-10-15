package agentharness

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/cloudwego/eino/schema"
)

func TestToolFeedbackDrivesRecoveryAndOnlyExecutorCanFinish(t *testing.T) {
	calls, executions := 0, 0
	err := Run(context.Background(), Config{Instructions: "Preserve {literal} rules", Request: "Save once", MaxIterations: 4,
		Tools: []Tool{{Name: "save", Parameters: map[string]any{"type": "object"}}},
		Decide: func(_ context.Context, history []*schema.Message) (Call, error) {
			calls++
			if calls == 2 && !strings.Contains(history[len(history)-1].Content, "patternMismatch") {
				t.Error("real rejection was not fed back")
			}
			return Call{Name: "save", Arguments: `{}`}, nil
		},
		Invoke: func(_ context.Context, call Call) (Outcome, error) {
			executions++
			if executions == 1 {
				return Outcome{Output: map[string]string{"rejected": "patternMismatch"}}, nil
			}
			return Outcome{Stop: true, Output: map[string]string{"verified": "saved"}}, nil
		},
	})
	if err != nil || calls != 2 || executions != 2 {
		t.Fatal(calls, executions, err)
	}
}

func TestAmbiguousMutationIsNeverReplayed(t *testing.T) {
	executions := 0
	err := Run(context.Background(), Config{Request: "Save once", MaxIterations: 4, Tools: []Tool{{Name: "save", Parameters: map[string]any{"type": "object"}}},
		Decide: func(context.Context, []*schema.Message) (Call, error) {
			return Call{Name: "save", Arguments: `{}`}, nil
		},
		Invoke: func(context.Context, Call) (Outcome, error) {
			executions++
			return Outcome{}, errors.New("ambiguous dispatch")
		},
	})
	if err == nil || executions != 1 {
		t.Fatal("mutation retried or false success", executions, err)
	}
}

func TestModelFailoverDoesNotRetryToolsOrReuseCallIDs(t *testing.T) {
	primary, backup, tools, switches := 0, 0, 0, 0
	err := Run(context.Background(), Config{Request: "Read then finish", MaxIterations: 4, Tools: []Tool{{Name: "read", Parameters: map[string]any{"type": "object"}}},
		Decide: func(context.Context, []*schema.Message) (Call, error) {
			primary++
			if primary == 2 {
				return Call{}, errors.New("unavailable")
			}
			return Call{Name: "read", Arguments: `{}`}, nil
		},
		FallbackDecide: func(_ context.Context, history []*schema.Message) (Call, error) {
			backup++
			if history[len(history)-1].Role != schema.Tool {
				t.Error("fallback lost completed tool feedback")
			}
			return Call{Name: "read", Arguments: `{}`}, nil
		},
		ShouldFailover: func(err error) bool { return err != nil }, OnFallback: func(error) { switches++ },
		Invoke: func(context.Context, Call) (Outcome, error) {
			tools++
			return Outcome{Stop: tools == 3, Output: "observed"}, nil
		},
	})
	if err != nil || primary != 2 || backup != 2 || tools != 3 || switches != 1 {
		t.Fatal(primary, backup, tools, switches, err)
	}
}

func TestUndeclaredToolAndCancellationCannotExecute(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		if cancelled {
			cancel()
		}
		executions := 0
		err := Run(ctx, Config{Request: "Read", MaxIterations: 2, Tools: []Tool{{Name: "read", Parameters: map[string]any{"type": "object"}}},
			Decide: func(context.Context, []*schema.Message) (Call, error) {
				return Call{Name: "shell", Arguments: `{}`}, nil
			},
			Invoke: func(context.Context, Call) (Outcome, error) { executions++; return Outcome{Stop: true}, nil },
		})
		cancel()
		if err == nil || executions != 0 {
			t.Fatal(cancelled, executions, err)
		}
	}
}
