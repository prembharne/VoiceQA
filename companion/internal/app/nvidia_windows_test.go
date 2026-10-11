//go:build windows

package app

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"voiceqa/companion/internal/core"
)

func TestNVIDIAKeyIsEncryptedSeparateAndBlankPreserved(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("NVIDIA_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("OPENROUTER_API_KEY", "")
	saved, err := a.dispatch(message("settings.save", map[string]any{"aiProvider": "nvidia", "model": "nvidia/nemotron-3-nano-30b-a3b", "apiKey": "nvapi-isolated-fixture"}))
	if err != nil {
		t.Fatal(err)
	}
	public := saved.(core.Settings)
	raw, _ := json.Marshal(public)
	if !public.HasAPIKey || public.APIKey != "" || strings.Contains(string(raw), "nvapi-isolated-fixture") {
		t.Fatal("key status or secrecy failed")
	}
	encrypted, err := os.ReadFile(filepath.Join(a.Store.Dir, "nvidia-api-key.dpapi"))
	if err != nil || bytes.Contains(encrypted, []byte("nvapi-isolated-fixture")) {
		t.Fatal("NVIDIA key not encrypted", err)
	}
	_, err = a.dispatch(message("settings.save", map[string]any{"apiKey": ""}))
	if err != nil || a.keyFor("nvidia") != "nvapi-isolated-fixture" {
		t.Fatal("blank key erased saved key", err)
	}
	if a.keyFor("openai") != "" || a.keyFor("openrouter") != "" || a.speechKey() != "" {
		t.Fatal("NVIDIA credential crossed providers")
	}
	var stored map[string]any
	_ = a.Store.Get("settings", "default", &stored)
	if stored["apiKey"] != nil {
		t.Fatal("key stored in JSON")
	}
}
