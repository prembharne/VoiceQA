package provider

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
)

// DecisionTools reuses exactly the native function contracts already sent to
// the provider. The ADK registry cannot silently introduce more capabilities.
type DecisionTool struct {
	Name       string
	Parameters map[string]any
}

// DecisionTurn is a completed tool exchange, not a proposed future action.
// Output is already sanitized by the caller's executor boundary.
type DecisionTurn struct {
	Name, Arguments, Output string
}

// ToolDecision prefers the model's native tool channel when its public catalog
// advertises support, even if it also supports strict JSON. Planning callers
// retain their existing format selection; this preference is local to one call.
func (c *Client) ToolDecision(ctx context.Context, key, model, instructions string, input, contract any, history []DecisionTurn) (json.RawMessage, map[string]int, error) {
	clone := *c
	clone.preferToolCalls = true
	clone.decisionHistory = history
	return clone.PlanStructured(ctx, key, model, instructions, input, contract, nil)
}

func DecisionTools(schema any) []DecisionTool {
	_, contracts := nativeResultFunctions(schema)
	var tools []DecisionTool
	for name, c := range contracts {
		tools = append(tools, DecisionTool{Name: name, Parameters: c.Parameters})
	}
	sort.Slice(tools, func(i, j int) bool { return tools[i].Name < tools[j].Name })
	return tools
}

func EncodeDecisionTool(schema any, raw json.RawMessage) (name, arguments string, err error) {
	_, contracts := nativeResultFunctions(schema)
	var packet struct {
		Result map[string]json.RawMessage `json:"result"`
	}
	if json.Unmarshal(raw, &packet) != nil || packet.Result == nil {
		return "", "", errors.New("AI decision requires a result object")
	}
	var kind, operation, toolName string
	_ = json.Unmarshal(packet.Result["type"], &kind)
	_ = json.Unmarshal(packet.Result["name"], &toolName)
	var fields map[string]json.RawMessage
	switch kind {
	case "action":
		for key := range packet.Result {
			if key != "type" && key != "action" {
				return "", "", errors.New("action cannot carry read or completion fields")
			}
		}
		_ = json.Unmarshal(packet.Result["action"], &fields)
		_ = json.Unmarshal(fields["operation"], &operation)
		delete(fields, "operation")
	case "tool":
		for key := range packet.Result {
			if key != "type" && key != "name" && key != "args" {
				return "", "", errors.New("read cannot carry action or completion fields")
			}
		}
		_ = json.Unmarshal(packet.Result["args"], &fields)
	default:
		fields = packet.Result
		delete(fields, "type")
	}
	for n, c := range contracts {
		if c.Kind == kind && c.Operation == operation && c.Tool == toolName {
			args, e := json.Marshal(fields)
			return n, string(args), e
		}
	}
	return "", "", errors.New("AI decision selected an undeclared tool")
}

func DecodeDecisionTool(schema any, name, arguments string) (json.RawMessage, error) {
	_, contracts := nativeResultFunctions(schema)
	c, ok := contracts[name]
	if !ok {
		return nil, errors.New("undeclared agent tool")
	}
	return c.decode(json.RawMessage(arguments))
}
