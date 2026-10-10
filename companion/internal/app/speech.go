package app

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/native"
	"voiceqa/companion/internal/secrets"
)

func defaultSettings() core.Settings {
	return core.Settings{AIProvider: "openai", Model: "gpt-5.6-sol", TranscriptionModel: "gpt-4o-mini-transcribe", MaskSelectors: "input[type=password], input[type=email], [data-private]", TTSProvider: "browser", TTSModel: "tts-1", TTSVoice: "alloy", TTSReuseMainKey: true}
}
func validateSpeechSettings(s core.Settings) error {
	if s.TTSProvider != "browser" && s.TTSProvider != "openai" {
		return errors.New("speech provider must be browser or openai")
	}
	if len(strings.TrimSpace(s.TTSModel)) == 0 || len(s.TTSModel) > 100 {
		return errors.New("invalid text-to-speech model")
	}
	if !validVoice(s.TTSVoice) {
		return errors.New("invalid text-to-speech voice")
	}
	return nil
}
func validVoice(voice string) bool {
	for _, v := range []string{"alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"} {
		if voice == v {
			return true
		}
	}
	return false
}
func (a *App) saveSecret(filename, value string) error {
	data, e := secrets.Protect([]byte(value))
	if e != nil {
		return e
	}
	return os.WriteFile(filepath.Join(a.Store.Dir, filename), data, 0600)
}
func (a *App) dedicatedTTSKey() string {
	if key := os.Getenv("VOICEQA_TTS_API_KEY"); key != "" {
		return key
	}
	data, e := os.ReadFile(filepath.Join(a.Store.Dir, "tts-api-key.dpapi"))
	if e != nil {
		return ""
	}
	data, e = secrets.Unprotect(data)
	if e != nil {
		return ""
	}
	return string(data)
}
func (a *App) ttsKey(s core.Settings) string {
	if key := a.dedicatedTTSKey(); key != "" {
		return key
	}
	if s.TTSReuseMainKey {
		return a.speechKey()
	}
	return ""
}
func (a *App) synthesize(parent context.Context, m native.Message) (any, error) {
	var p struct {
		Text     string `json:"text"`
		SpeechID string `json:"speechId"`
	}
	if e := decode(m, &p); e != nil {
		return nil, e
	}
	p.Text = strings.TrimSpace(p.Text)
	if p.Text == "" || len([]rune(p.Text)) > 4096 || p.SpeechID == "" || len(p.SpeechID) > 128 {
		return nil, errors.New("speech requires an ID and 1–4096 characters")
	}
	s := a.getSettings()
	if s.TTSProvider != "openai" {
		return nil, errors.New("choose OpenAI API speech in Local setup first")
	}
	if e := validateSpeechSettings(s); e != nil {
		return nil, e
	}
	key := a.ttsKey(s)
	if key == "" {
		return nil, errors.New("add a text-to-speech API key or explicitly enable reuse of the main key")
	}
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	a.mu.Lock()
	if _, cancelled := a.speechCancelled[p.SpeechID]; cancelled {
		a.mu.Unlock()
		return nil, context.Canceled
	}
	if _, exists := a.speechCancels[p.SpeechID]; exists || len(a.speechCancels) >= 2 {
		a.mu.Unlock()
		return nil, errors.New("speech is already in progress")
	}
	a.speechCancels[p.SpeechID] = cancel
	a.mu.Unlock()
	defer func() { a.mu.Lock(); delete(a.speechCancels, p.SpeechID); a.mu.Unlock() }()
	audio, e := a.Provider.Speech(ctx, key, s.TTSModel, s.TTSVoice, p.Text)
	if e != nil {
		return nil, e
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	id := core.ID()
	if e = a.Store.WriteArtifact(id, audio); e != nil {
		return nil, e
	}
	if e = a.Store.Put("speech-artifact", id, map[string]any{"id": id, "expires": time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339Nano)}); e != nil {
		_ = os.Remove(a.Store.Artifact(id))
		return nil, e
	}
	return map[string]any{"artifactId": id, "mime": "audio/mpeg", "model": s.TTSModel, "voice": s.TTSVoice}, nil
}
func (a *App) releaseSpeech(m native.Message) (any, error) {
	var p struct {
		ArtifactID string `json:"artifactId"`
	}
	if e := decode(m, &p); e != nil {
		return nil, e
	}
	var marker map[string]any
	if e := a.Store.Get("speech-artifact", p.ArtifactID, &marker); e != nil {
		return nil, errors.New("not a temporary speech artifact")
	}
	if _, e := a.Store.ReadArtifact(p.ArtifactID); e != nil && !os.IsNotExist(e) {
		return nil, e
	}
	if e := os.Remove(a.Store.Artifact(p.ArtifactID)); e != nil && !os.IsNotExist(e) {
		return nil, e
	}
	_, e := a.Store.DB.Exec(`DELETE FROM records WHERE kind='speech-artifact' AND id=?`, p.ArtifactID)
	return map[string]any{"released": true}, e
}
func (a *App) cleanSpeechArtifacts() {
	raw, _ := a.Store.List("speech-artifact")
	for _, b := range raw {
		var marker struct {
			ID      string `json:"id"`
			Expires string `json:"expires"`
		}
		if json.Unmarshal(b, &marker) != nil {
			continue
		}
		expiry, e := time.Parse(time.RFC3339Nano, marker.Expires)
		if e == nil && time.Now().After(expiry) {
			p, _ := json.Marshal(map[string]string{"artifactId": marker.ID})
			_, _ = a.releaseSpeech(native.Message{Payload: p})
		}
	}
}
