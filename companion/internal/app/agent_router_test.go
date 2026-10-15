package app

import (
	"encoding/json"
	"testing"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/visualagent"
)

func TestRouterKeepsEasyProgressOnDOMAndRecoversStagnation(t *testing.T) {
	var p progressRouter
	for i := 0; i < 4; i++ {
		p.observe(map[string]any{"text": i})
		if got := p.reason(true, false, 24); got != "" {
			t.Fatalf("Progress routed to paid vision: %s", got)
		}
	}
	p.observe(map[string]any{"text": 3})
	p.observe(map[string]any{"text": 3})
	if p.reason(true, false, 20) == "" {
		t.Fatal("Stagnation did not route")
	}
	if p.reason(false, true, 0) != "" {
		t.Fatal("Missing runtime must not be selected")
	}
	if (&progressRouter{}).reason(true, true, 24) == "" {
		t.Fatal("Pre-dispatch failure was not recoverable")
	}
}
func TestVisualPrivilegesCannotBeSuppliedByModelJSON(t *testing.T) {
	var a core.Action
	if err := json.Unmarshal([]byte(`{"operation":"click","visual":{"snapshot":"stolen","x":1,"y":2}}`), &a); err != nil {
		t.Fatal(err)
	}
	if a.Visual != nil {
		t.Fatal("Untrusted model supplied a visual execution attachment")
	}
}
func TestRouterIgnoresFocusAndControlOrderingAsProgress(t *testing.T) {
	var p progressRouter
	p.observe(map[string]any{"controls": []any{map[string]any{"target": "a", "focused": false}, map[string]any{"target": "b", "focused": true}}})
	original := p.fingerprint
	p.observe(map[string]any{"controls": []any{map[string]any{"target": "b", "focused": false}, map[string]any{"target": "a", "focused": true}}})
	if p.fingerprint != original || p.unchanged != 1 {
		t.Fatal("Focus/reordering hid a stalled workflow")
	}
}
func TestVisualPixelsConvertToCurrentCSSViewport(t *testing.T) {
	p := visualPoint(visualagent.Reply{Result: visualagent.Intent{X: 1200, Y: 600, Width: 2560, Height: 1440}}, map[string]any{"snapshot": "once", "width": float64(1280), "height": float64(720)})
	if p.X != 600 || p.Y != 300 || p.Width != 1280 || p.Height != 720 {
		t.Fatal(p)
	}
}
