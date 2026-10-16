package app

import (
	"encoding/json"
	"testing"
)

func TestModelControlCompactionPreservesRulesValuesAndSourceEvidence(t *testing.T) {
	controls := []any{}
	for i := 0; i < 40; i++ {
		controls = append(controls, map[string]any{"target": "#button", "tag": "button", "role": "button", "name": "Open", "text": "Open", "value": "", "disabled": false, "checked": false, "editable": false, "editor": false, "draggable": false, "required": false, "focused": false, "expanded": nil, "pressed": nil, "href": "", "min": "", "max": "", "inputType": "", "options": []any{}, "selectedIndex": nil, "parameterizedLink": false})
	}
	controls[0] = map[string]any{"target": "#handle", "role": "textbox", "editable": true, "value": "", "required": true, "expanded": "false"}
	controls[1] = map[string]any{"target": "#consent", "role": "checkbox", "checked": false, "disabled": true}
	view := map[string]any{"controls": controls, "text": "A seat costs 200 and the service fee is 10", "results": []any{map[string]any{"target": "#total", "text": "$410.00"}}, "url": "https://app.test/?token=private"}
	// Compact before transport truncation too, so useful controls survive the
	// evidence allowance. Compare with the original verbose browser payload.
	before, _ := json.Marshal(view)
	model := automationModelObservation(view)
	after, _ := json.Marshal(model)
	if len(after) >= len(before)*3/5 {
		t.Fatal("redundant metadata not reduced", len(before), len(after))
	}
	rows := model["controls"].([]any)
	if rows[0].(map[string]any)["value"] != "" || rows[0].(map[string]any)["required"] != true || rows[0].(map[string]any)["expanded"] != "false" || rows[1].(map[string]any)["checked"] != false || rows[1].(map[string]any)["disabled"] != true {
		t.Fatal("meaningful control state removed")
	}
	if model["text"] != view["text"] || model["results"].([]any)[0].(map[string]any)["text"] != "$410.00" {
		t.Fatal("oracle evidence changed")
	}
	if controls[2].(map[string]any)["disabled"] != false || controls[2].(map[string]any)["text"] != "Open" {
		t.Fatal("source recording mutated")
	}
	history := automationModelHistory([]map[string]any{{"id": "O4", "afterActions": 3, "evidence": view}})
	if history[0]["id"] != "O4" || history[0]["afterActions"] != 3 {
		t.Fatal("provenance lost")
	}
}
