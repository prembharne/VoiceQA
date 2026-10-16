package visualagent

import "testing"

func TestAcceptanceModelDoesNotChangeDefault(t *testing.T) {
	t.Setenv("VOICEQA_ACCEPTANCE_MODEL", "")
	if ModelName() != Model {
		t.Fatal("default model changed")
	}
	t.Setenv("VOICEQA_ACCEPTANCE_MODEL", AcceptanceModel)
	if ModelName() != AcceptanceModel {
		t.Fatal("visual lane ignored exact acceptance model")
	}
}
