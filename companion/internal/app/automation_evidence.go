package app

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
				if !v && !(key == "checked" && (row["role"] == "checkbox" || row["role"] == "radio")) && !(key == "parameterizedLink" && row["href"] != "" && row["href"] != nil) {
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
	for _, record := range records {
		evidence, _ := record["evidence"].(map[string]any)
		compact = append(compact, map[string]any{"id": record["id"], "afterActions": record["afterActions"], "evidence": automationModelObservation(evidence)})
	}
	return compact
}
