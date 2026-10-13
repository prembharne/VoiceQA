package provider

import (
	"strings"
	"testing"
)

func TestStreamErrorRetainsStatusWithoutLeakingProviderText(t *testing.T) {
	raw := `data: {"error":{"code":502,"message":"request key sk-secret should never reach chat"}}` + "\n\n"
	_, err := readChatStream(strings.NewReader(raw), nil)
	if err == nil || !strings.Contains(err.Error(), "502") || strings.Contains(err.Error(), "sk-secret") {
		t.Fatal("lost provider status or exposed raw upstream message", err)
	}
}
