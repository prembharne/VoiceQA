//go:build windows

package app

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"voiceqa/companion/internal/core"
)

func TestTTSKeyIsEncryptedAndNeverReturnedOrPersistedInJSON(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("VOICEQA_TTS_API_KEY", "")
	s := a.getSettings()
	s.TTSAPIKey = "tts-private-fixture-value"
	result, e := a.dispatch(message("settings.save", s))
	if e != nil {
		t.Fatal(e)
	}
	if public, ok := result.(core.Settings); !ok || public.TTSAPIKey != "" {
		t.Fatal("settings response exposed the key")
	}
	data, e := os.ReadFile(filepath.Join(a.Store.Dir, "tts-api-key.dpapi"))
	if e != nil || bytes.Contains(data, []byte(s.TTSAPIKey)) {
		t.Fatal("key was not encrypted", e)
	}
	var body map[string]any
	_ = a.Store.Get("settings", "default", &body)
	if body["ttsApiKey"] != nil {
		t.Fatal("plaintext TTS key persisted")
	}
	if a.getSettings().TTSAPIKey != "" || !a.getSettings().HasTTSAPIKey {
		t.Fatal("public settings exposed key or lost its status")
	}
	s.TTSAPIKey = ""
	_, e = a.dispatch(message("settings.save", s))
	if e != nil || a.dedicatedTTSKey() != "tts-private-fixture-value" {
		t.Fatal("blank field erased saved key", e)
	}
}
