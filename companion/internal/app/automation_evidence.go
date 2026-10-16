package app

import "encoding/json"

func compactControlRows(view map[string]any) {
	rows, _ := view["controls"].([]any)
	for _, raw := range rows {
		row, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		for key, value := range row {
			if value == nil {
				delete(row, key)
				continue
			}
			switch v := value.(type) {
			case bool:
				if !v && key != "valueComplete" && !(key == "checked" && (row["role"] == "checkbox" || row["role"] == "radio")) && !(key == "parameterizedLink" && row["href"] != "" && row["href"] != nil) {
					delete(row, key)
				}
			case string:
				if v == "" && key != "value" {
					delete(row, key)
				}
				if key == "text" && v == row["name"] {
					delete(row, key)
				}
			case []any:
				if len(v) == 0 {
					delete(row, key)
				}
			}
		}
	}
}

// Compact only redundant control metadata sent to the model. Full recorded
// observations and all result/oracle values remain unchanged for verification.
func automationModelObservation(view map[string]any) map[string]any {
	compact := agentPublicEvidence(view)
	controls, _ := compact["controls"].([]any)
	for _, raw := range controls {
		row, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		for key, value := range row {
			if value == nil {
				delete(row, key)
				continue
			}
			switch v := value.(type) {
			case string:
				if v == "" && !(key == "value" && (row["editable"] == true || row["role"] == "textbox" || row["role"] == "combobox")) {
					delete(row, key)
				}
				if key == "text" && v == row["name"] {
					delete(row, key)
				}
			case bool:
				if !v && key != "valueComplete" && !(key == "checked" && (row["role"] == "checkbox" || row["role"] == "radio")) && !(key == "parameterizedLink" && row["href"] != "" && row["href"] != nil) {
					delete(row, key)
				}
			case []any:
				if len(v) == 0 {
					delete(row, key)
				}
			}
		}
	}
	return compact
}

func automationModelHistory(records []map[string]any) []map[string]any {
	compact := make([]map[string]any, 0, len(records))
	texts := map[string]string{}
	for _, record := range records {
		evidence, _ := record["evidence"].(map[string]any)
		view := automationModelObservation(evidence)
		if text, ok := view["text"].(string); ok {
			if prior := texts[text]; prior != "" {
				delete(view, "text")
				view["sameTextAs"] = prior
			} else {
				texts[text] = stringField(record, "id")
			}
		}
		// Historical controls retain actual public field values/options, not a
		// repeated full toolbar. Current control discovery has its own snapshot.
		values := []any{}
		if controls, ok := view["controls"].([]any); ok {
			for _, raw := range controls {
				row, ok := raw.(map[string]any)
				if !ok {
					continue
				}
				if (row["value"] != "" && row["value"] != nil) || row["options"] != nil {
					values = append(values, map[string]any{"target": row["target"], "name": row["name"], "value": row["value"], "valueComplete": row["valueComplete"], "options": row["options"]})
				}
			}
		}
		view["controls"] = values
		compact = append(compact, map[string]any{"id": record["id"], "afterActions": record["afterActions"], "evidence": view})
	}
	for i := 1; i < len(compact)-1; i++ {
		body, _ := json.Marshal(compact)
		if len(body) <= 32000 {
			break
		}
		compact[i] = map[string]any{"id": compact[i]["id"], "afterActions": compact[i]["afterActions"], "detailsOmitted": true}
	}
	return compact
}
