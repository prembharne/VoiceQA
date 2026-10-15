package provider

import (
	"encoding/json"
	"errors"
	"regexp"
	"sort"
)

// These functions are a typed result channel, not browser dispatch. The local
// controller still validates permissions, scope and operation arguments.
type functionContract struct {
	Parameters map[string]any
	Kind       string
	Operation  string
	Tool       string
	RootFields []string
}

var functionPart = regexp.MustCompile(`^[a-z][a-z0-9_]{0,39}$`)

func nativeResultFunctions(schema any) ([]any, map[string]functionContract) {
	root, ok := compactJSONContract(schema).(map[string]any)
	if !ok {
		return genericResultFunction(schema)
	}
	props, _ := root["properties"].(map[string]any)
	result, _ := props["result"].(map[string]any)
	variants, _ := result["anyOf"].([]any)
	if len(variants) == 0 {
		return genericResultFunction(schema)
	}
	contracts := map[string]functionContract{}
	for _, raw := range variants {
		variant, _ := raw.(map[string]any)
		fields, _ := variant["properties"].(map[string]any)
		kinds := enumStrings(fields["type"])
		if len(kinds) != 1 || !functionPart.MatchString(kinds[0]) {
			return genericResultFunction(schema)
		}
		base := map[string]any{}
		rootFields := []string{}
		for key, value := range props {
			if key != "result" {
				base[key] = value
				rootFields = append(rootFields, key)
			}
		}
		sort.Strings(rootFields)
		kind := kinds[0]
		add := func(name string, fields map[string]any, operation, tool string) bool {
			if _, exists := contracts[name]; exists || len(name) > 64 {
				return false
			}
			arguments := map[string]any{}
			for key, value := range base {
				arguments[key] = value
			}
			for key, value := range fields {
				if _, collision := arguments[key]; collision {
					return false
				}
				arguments[key] = value
			}
			contracts[name] = functionContract{Parameters: Object(arguments), Kind: kind, Operation: operation, Tool: tool, RootFields: rootFields}
			return true
		}
		if kind == "action" {
			action, _ := fields["action"].(map[string]any)
			shapes, _ := action["anyOf"].([]any)
			if len(shapes) == 0 || len(fields) != 2 {
				return genericResultFunction(schema)
			}
			for _, rawShape := range shapes {
				shape, _ := rawShape.(map[string]any)
				actionFields, _ := shape["properties"].(map[string]any)
				operations := enumStrings(actionFields["operation"])
				if len(operations) == 0 {
					return genericResultFunction(schema)
				}
				args := withoutFields(actionFields, "operation")
				for _, operation := range operations {
					if !functionPart.MatchString(operation) || !add("browser_"+operation, args, operation, "") {
						return genericResultFunction(schema)
					}
				}
			}
		} else if kind == "tool" {
			names := enumStrings(fields["name"])
			args, _ := fields["args"].(map[string]any)
			argFields, _ := args["properties"].(map[string]any)
			if len(names) != 1 || !functionPart.MatchString(names[0]) || len(fields) != 3 || !add("browser_"+names[0], argFields, "", names[0]) {
				return genericResultFunction(schema)
			}
		} else if !add("report_"+kind, withoutFields(fields, "type"), "", "") {
			return genericResultFunction(schema)
		}
	}
	names := []string{}
	for name := range contracts {
		names = append(names, name)
	}
	sort.Strings(names)
	functions := []any{}
	for _, name := range names {
		functions = append(functions, resultFunction(name, contracts[name].Parameters))
	}
	return functions, contracts
}

func resultFunction(name string, schema any) map[string]any {
	return map[string]any{"type": "function", "function": map[string]any{"name": name, "description": "Return this single decision using the declared arguments. Execution and validation are performed separately by the local controller.", "parameters": schema}}
}

func genericResultFunction(schema any) ([]any, map[string]functionContract) {
	return []any{resultFunction("submit_result", compactJSONContract(schema))}, map[string]functionContract{"submit_result": {}}
}

func enumStrings(raw any) []string {
	shape, _ := raw.(map[string]any)
	values, _ := shape["enum"].([]any)
	result := []string{}
	for _, value := range values {
		s, ok := value.(string)
		if !ok {
			return nil
		}
		result = append(result, s)
	}
	return result
}

func withoutFields(fields map[string]any, excluded ...string) map[string]any {
	result := map[string]any{}
	for key, value := range fields {
		omit := false
		for _, name := range excluded {
			omit = omit || key == name
		}
		if !omit {
			result[key] = value
		}
	}
	return result
}

func (contract functionContract) decode(arguments json.RawMessage) (json.RawMessage, error) {
	if contract.Kind == "" {
		return arguments, nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(arguments, &fields); err != nil || fields == nil {
		return nil, errors.New("AI function arguments must be an object")
	}
	allowed := contract.Parameters["properties"].(map[string]any)
	for key := range fields {
		if _, ok := allowed[key]; !ok {
			return nil, errors.New("AI function supplied undeclared arguments; no action was dispatched")
		}
	}
	root := map[string]any{}
	for _, key := range contract.RootFields {
		if value, ok := fields[key]; ok {
			root[key] = value
			delete(fields, key)
		}
	}
	result := map[string]any{"type": contract.Kind}
	if contract.Operation != "" {
		action := map[string]any{"operation": contract.Operation}
		for key, value := range fields {
			action[key] = value
		}
		result["action"] = action
	} else if contract.Tool != "" {
		result["name"], result["args"] = contract.Tool, fields
	} else {
		for key, value := range fields {
			result[key] = value
		}
	}
	root["result"] = result
	return json.Marshal(root)
}

// Some tool-capable endpoints return plain argument JSON instead of a call.
// Restore a missing envelope only when the exact declared field signature is
// unique. Shared shapes (e.g. fill/select) never imply an operation by guessing.
func restoreUniqueFunctionReply(raw json.RawMessage, contracts map[string]functionContract) (json.RawMessage, bool, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || len(fields) == 0 || fields["result"] != nil {
		return raw, false, nil
	}
	var selected *functionContract
	for _, contract := range contracts {
		if contract.Kind == "" {
			continue
		}
		props := contract.Parameters["properties"].(map[string]any)
		matches := true
		for key := range fields {
			_, known := props[key]
			matches = matches && known
		}
		for _, key := range contract.Parameters["required"].([]string) {
			_, present := fields[key]
			matches = matches && present
		}
		if matches {
			if selected != nil {
				return raw, false, nil
			}
			copy := contract
			selected = &copy
		}
	}
	if selected == nil {
		return raw, false, nil
	}
	result, err := selected.decode(raw)
	return result, err == nil, err
}
