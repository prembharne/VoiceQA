package app

import "testing"

func TestVisualCaptionRejectsRecordedRemixMisgroundingBeforeInput(t *testing.T) {
	if err := validateVisualCaption("name function button", map[string]any{"name": "Explain contract", "tag": "BUTTON"}); err == nil {
		t.Fatal("recorded wrong-button hit accepted")
	}
	for _, test := range []struct{ description, name, tag string }{
		{"Compile button", "Compile", "BUTTON"},
		{"Close button on Plan & Credits dialog", "Close", "BUTTON"},
		{"Call button for the name function", "Call", "BUTTON"},
		{"Account 1 selector", "Account 10x5B3...eddC499.999 ETH", "BUTTON"},
		{"Deploy icon in left sidebar", "udapp", "svg"},
	} {
		if err := validateVisualCaption(test.description, map[string]any{"name": test.name, "tag": test.tag}); err != nil {
			t.Fatal("valid or dynamic-caption control rejected", test, err)
		}
	}
}
