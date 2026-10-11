package provider

import (
	"encoding/json"
	"strings"
	"testing"
	"voiceqa/companion/internal/core"
)

func TestWorkspaceSuitesStayInsideSupportedBounds(t *testing.T) {
	origin := "http://127.0.0.1:4173"
	plans := []core.Plan{WorkspaceDemoPlan(origin+"/", origin, "Run application suite"), WorkspaceLayoutPlan(origin+"/app/layout", origin, "Run layout suite"), WorkspaceAuthPlan(origin+"/app/auth", origin, "Run auth suite", "relay"), WorkspaceSecurityPlan(origin+"/app/security", origin, "Run security suite", true)}
	for _, p := range plans {
		if err := core.ValidatePlan(p); err != nil {
			t.Fatal(p.Summary, err)
		}
	}
	if WorkspaceAuthPlan(origin+"/app/auth", origin, "Test auth", "").Clarification == "" {
		t.Fatal("missing profile silently accepted")
	}
	if WorkspaceSecurityPlan(origin+"/app/security", origin, "Test security", false).Clarification == "" {
		t.Fatal("missing authorization silently accepted")
	}
}

func TestWorkspaceModelContractIsCompactAndDoesNotRequireUndefinedRows(t *testing.T) {
	raw, e := json.Marshal(WorkspaceRequirements("http://127.0.0.1:4173/", "http://127.0.0.1:4173"))
	if e != nil || len(raw) > 5000 || strings.Contains(string(raw), "${quantity}") || strings.Contains(string(raw), "${total}") {
		t.Fatal("model contract is not compact or has undefined fixture variables", len(raw), e)
	}
	if !strings.Contains(string(raw), "testid:order-id") || !strings.Contains(string(raw), "/workspace/api/orders/${order-id}") {
		t.Fatal("capture-to-server contract missing")
	}
}
