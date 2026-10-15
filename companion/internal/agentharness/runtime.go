// Package agentharness embeds Eino ADK without granting it application privileges.
// Callers supply the model, tool catalog and policy. A tool result, never model
// prose, is the only way to stop successfully.
package agentharness

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync/atomic"

	"github.com/cloudwego/eino/adk"
	"github.com/cloudwego/eino/components/model"
	"github.com/cloudwego/eino/components/tool"
	"github.com/cloudwego/eino/compose"
	"github.com/cloudwego/eino/schema"
	"github.com/eino-contrib/jsonschema"
)

const Runtime = "eino-adk/0.9.21"

type Call struct {
	Name      string
	Arguments string
}

type Tool struct {
	Name       string
	Parameters map[string]any
}

// Outcome.Stop means the application's terminal gate has already run. It does
// not mean success: applications also stop on measured failures and blockers.
type Outcome struct {
	Output any
	Stop   bool
}

type Config struct {
	Instructions  string
	Request       string
	MaxIterations int
	Tools         []Tool
	Decide        func(context.Context, []*schema.Message) (Call, error)
	Invoke        func(context.Context, Call) (Outcome, error)
	// Observe receives only metadata, not prompts, arguments or credential data.
	Observe        func(kind, tool string)
	FallbackDecide func(context.Context, []*schema.Message) (Call, error)
	ShouldFailover func(error) bool
	OnFallback     func(error)
}

type decisionModel struct {
	decide  func(context.Context, []*schema.Message) (Call, error)
	seq     *atomic.Uint64
	known   map[string]bool
	stopped *atomic.Bool
}

func (m *decisionModel) Generate(ctx context.Context, input []*schema.Message, _ ...model.Option) (*schema.Message, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if m.stopped.Load() {
		return schema.AssistantMessage("Application outcome gate finished.", nil), nil
	}
	call, err := m.decide(ctx, input)
	if err != nil {
		return nil, err
	}
	if !m.known[call.Name] || !json.Valid([]byte(call.Arguments)) {
		return nil, errors.New("agent returned an undeclared tool or invalid arguments; nothing was executed")
	}
	return &schema.Message{Role: schema.Assistant, ToolCalls: []schema.ToolCall{{ID: fmt.Sprintf("decision-%d", m.seq.Add(1)), Type: "function", Function: schema.FunctionCall{Name: call.Name, Arguments: call.Arguments}}}}, nil
}

func (m *decisionModel) Stream(ctx context.Context, input []*schema.Message, opts ...model.Option) (*schema.StreamReader[*schema.Message], error) {
	msg, err := m.Generate(ctx, input, opts...)
	if err != nil {
		return nil, err
	}
	return schema.StreamReaderFromArray([]*schema.Message{msg}), nil
}

type invocationTool struct {
	info    *schema.ToolInfo
	invoke  func(context.Context, Call) (Outcome, error)
	stopped *atomic.Bool
}

func (t *invocationTool) Info(context.Context) (*schema.ToolInfo, error) { return t.info, nil }
func (t *invocationTool) InvokableRun(ctx context.Context, args string, _ ...tool.Option) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	out, err := t.invoke(ctx, Call{Name: t.info.Name, Arguments: args})
	if err != nil {
		return "", err
	} // Fatal/ambiguous dispatch is never retried.
	encoded, err := json.Marshal(out.Output)
	if err != nil {
		return "", err
	}
	if out.Stop {
		t.stopped.Store(true)
	}
	return string(encoded), nil
}

// boundedTranscript keeps complete call/result pairs. The application owns the
// durable evidence ledger; retaining every large tool reply here would duplicate
// that ledger and inflate each subsequent request. No extra summarizer is used.
type boundedTranscript struct {
	*adk.BaseChatModelAgentMiddleware
}

func (h *boundedTranscript) BeforeModelRewriteState(ctx context.Context, state *adk.ChatModelAgentState, _ *adk.ModelContext) (context.Context, *adk.ChatModelAgentState, error) {
	if len(state.Messages) > 8 {
		start := len(state.Messages) - 6
		for start < len(state.Messages) && state.Messages[start].Role != schema.Assistant {
			start++
		}
		state.Messages = append(append([]*schema.Message(nil), state.Messages[:2]...), state.Messages[start:]...)
	}
	return ctx, state, nil
}

func Run(ctx context.Context, cfg Config) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if cfg.Decide == nil || cfg.Invoke == nil || cfg.MaxIterations < 1 || len(cfg.Tools) == 0 {
		return errors.New("agent harness requires a model, tools, executor and bounded iterations")
	}
	var stopped atomic.Bool
	m := &decisionModel{decide: cfg.Decide, known: map[string]bool{}, seq: &atomic.Uint64{}, stopped: &stopped}
	tools := make([]tool.BaseTool, 0, len(cfg.Tools))
	for _, def := range cfg.Tools {
		if def.Name == "" || m.known[def.Name] {
			return errors.New("agent tool names must be unique and nonempty")
		}
		m.known[def.Name] = true
		raw, err := json.Marshal(def.Parameters)
		if err != nil {
			return err
		}
		var params jsonschema.Schema
		if err = json.Unmarshal(raw, &params); err != nil {
			return err
		}
		tools = append(tools, &invocationTool{info: &schema.ToolInfo{Name: def.Name, Desc: "Use this declared tool through the application's validation and outcome checks.", ParamsOneOf: schema.NewParamsOneOfByJSONSchema(&params)}, invoke: cfg.Invoke, stopped: &stopped})
	}
	agentConfig := &adk.ChatModelAgentConfig{
		Name: "voiceqa", Instruction: cfg.Instructions, Model: m, MaxIterations: cfg.MaxIterations + 1,
		// Avoid interpreting braces in user instructions as template variables.
		GenModelInput: func(_ context.Context, instruction string, input *adk.AgentInput) ([]*schema.Message, error) {
			return append([]*schema.Message{schema.SystemMessage(instruction)}, input.Messages...), nil
		},
		ToolsConfig: adk.ToolsConfig{ToolsNodeConfig: compose.ToolsNodeConfig{Tools: tools, ExecuteSequentially: true}},
		Handlers:    []adk.ChatModelAgentMiddleware{&boundedTranscript{&adk.BaseChatModelAgentMiddleware{}}},
	}
	if cfg.FallbackDecide != nil && cfg.ShouldFailover != nil {
		used := false
		agentConfig.ModelFailoverConfig = &adk.ModelFailoverConfig[*schema.Message]{
			MaxRetries: 1,
			ShouldFailover: func(ctx context.Context, _ *schema.Message, err error) bool {
				return ctx.Err() == nil && cfg.ShouldFailover(err)
			},
			GetFailoverModel: func(_ context.Context, fc *adk.FailoverContext[*schema.Message]) (model.BaseChatModel, []*schema.Message, error) {
				if used {
					return nil, nil, fc.LastErr
				}
				used = true
				if cfg.OnFallback != nil {
					cfg.OnFallback(fc.LastErr)
				}
				return &decisionModel{decide: cfg.FallbackDecide, known: m.known, seq: m.seq, stopped: &stopped}, nil, nil
			},
		}
	}
	agent, err := adk.NewChatModelAgent(ctx, agentConfig)
	if err != nil {
		return err
	}
	runner := adk.NewRunner(ctx, adk.RunnerConfig{Agent: agent})
	for iter := runner.Query(ctx, cfg.Request); ; {
		event, ok := iter.Next()
		if !ok {
			break
		}
		if event.Err != nil {
			return event.Err
		}
		if cfg.Observe != nil && event.Output != nil && event.Output.MessageOutput != nil {
			msg := event.Output.MessageOutput.Message
			if msg != nil {
				for _, call := range msg.ToolCalls {
					cfg.Observe("decision", call.Function.Name)
				}
				if msg.Role == schema.Tool {
					cfg.Observe("tool_result", msg.ToolName)
				}
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if !stopped.Load() {
		return errors.New("agent stopped without application-verified completion")
	}
	return nil
}
