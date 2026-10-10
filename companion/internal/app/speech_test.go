package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"voiceqa/companion/internal/core"
)

func TestLegacySettingsDefaultToBrowserSpeech(t *testing.T) {
	a := newTestApp(t)
	_ = a.Store.Put("settings", "default", map[string]any{"model": "existing", "transcriptionModel": "existing-transcriber", "maskSelectors": "input[type=password]"})
	b := New(a.Store, a.Send)
	s := b.getSettings()
	if s.TTSProvider != "browser" || s.TTSModel != "tts-1" || s.TTSVoice != "alloy" || !s.TTSReuseMainKey {
		t.Fatal("legacy settings lost defaults", s)
	}
}
func TestTTSKeyPrecedenceIsExplicit(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("OPENAI_API_KEY", "main-fixture-key")
	t.Setenv("VOICEQA_TTS_API_KEY", "")
	s := a.getSettings()
	s.TTSReuseMainKey = false
	if a.ttsKey(s) != "" {
		t.Fatal("main key silently reused")
	}
	s.TTSReuseMainKey = true
	if a.ttsKey(s) != "main-fixture-key" {
		t.Fatal("explicit key reuse failed")
	}
	t.Setenv("VOICEQA_TTS_API_KEY", "tts-fixture-key")
	if a.ttsKey(s) != "tts-fixture-key" {
		t.Fatal("dedicated key did not take precedence")
	}
	if a.getSettings().TTSAPIKey != "" {
		t.Fatal("key exposed in settings")
	}
}
func TestAPISpeechTransfersAndReleasesTemporaryArtifact(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("VOICEQA_TTS_API_KEY", "tts-fixture-key")
	a.settings.TTSProvider = "openai"
	mp3 := []byte("ID3-fixture-audio")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/audio/speech" || r.Header.Get("Authorization") != "Bearer tts-fixture-key" {
			t.Error("wrong speech endpoint or key")
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["model"] != "tts-1" || body["voice"] != "alloy" || body["response_format"] != "mp3" {
			t.Error("incorrect speech configuration", body)
		}
		w.Header().Set("Content-Type", "audio/mpeg")
		_, _ = w.Write(mp3)
	}))
	defer server.Close()
	a.Provider.BaseURL = server.URL
	result, e := a.dispatch(message("speech.synthesize", map[string]string{"text": "Hello VoiceQA", "speechId": "clip"}))
	if e != nil {
		t.Fatal(e)
	}
	id := result.(map[string]any)["artifactId"].(string)
	data, e := a.Store.ReadArtifact(id)
	if e != nil || !bytes.Equal(data, mp3) {
		t.Fatal("speech artifact changed", e)
	}
	if _, e = a.dispatch(message("speech.release", map[string]string{"artifactId": id})); e != nil {
		t.Fatal(e)
	}
	if _, e = os.Stat(a.Store.Artifact(id)); !os.IsNotExist(e) {
		t.Fatal("temporary speech artifact remained")
	}
}
func TestSpeechCancellationCannotBeLostBeforeRegistration(t *testing.T) {
	a := newTestApp(t)
	t.Setenv("VOICEQA_TTS_API_KEY", "fixture-key")
	a.settings.TTSProvider = "openai"
	_, _ = a.dispatch(message("speech.cancel", map[string]string{"speechId": "early-cancel"}))
	_, e := a.dispatch(message("speech.synthesize", map[string]string{"text": "Must not generate", "speechId": "early-cancel"}))
	if e != context.Canceled {
		t.Fatal("early cancellation was lost", e)
	}
}
func TestSpeechReleaseCannotDeleteEvidence(t *testing.T) {
	a := newTestApp(t)
	id := core.ID()
	_ = a.Store.WriteArtifact(id, []byte("evidence"))
	if _, e := a.dispatch(message("speech.release", map[string]string{"artifactId": id})); e == nil {
		t.Fatal("evidence deletion accepted")
	}
	if _, e := os.Stat(filepath.Join(a.Store.Dir, "artifacts", id+".bin")); e != nil {
		t.Fatal("evidence removed")
	}
}
