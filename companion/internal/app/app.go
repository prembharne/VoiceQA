package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/native"
	"voiceqa/companion/internal/provider"
	"voiceqa/companion/internal/secrets"
	"voiceqa/companion/internal/store"
)

type browserReply struct {
	Result map[string]any
	Error  string
	Code   string
}
type upload struct {
	Data    []byte
	Next    int
	Size    int
	MIME    string
	SHA     string
	Created time.Time
}
type App struct {
	Store           *store.Store
	Provider        *provider.Client
	Send            func(native.Message) error
	mu              sync.Mutex
	pending         map[string]chan browserReply
	uploads         map[string]*upload
	activeID        string
	cancel          context.CancelFunc
	settings        core.Settings
	workCancels     map[string]context.CancelFunc
	speechCancels   map[string]context.CancelFunc
	speechCancelled map[string]time.Time
	closing         bool
}

func New(s *store.Store, send func(native.Message) error) *App {
	a := &App{Store: s, Provider: provider.New(), Send: send, pending: map[string]chan browserReply{}, uploads: map[string]*upload{}, workCancels: map[string]context.CancelFunc{}, speechCancels: map[string]context.CancelFunc{}, speechCancelled: map[string]time.Time{}}
	a.settings = defaultSettings()
	_ = s.Get("settings", "default", &a.settings)
	a.cleanSpeechArtifacts()
	runs, _ := s.List("run")
	for _, raw := range runs {
		var r core.Run
		if json.Unmarshal(raw, &r) == nil && (r.Status == "running" || r.Status == "paused" || r.Status == "queued") {
			r.Status = "error"
			r.Error = "Companion interrupted. Dispatched actions have unknown outcomes and were not replayed."
			r.CompletedAt = core.Now()
			_ = s.Put("run", r.ID, r)
		}
	}
	return a
}
func (a *App) Close() {
	a.mu.Lock()
	a.closing = true
	if a.cancel != nil {
		a.cancel()
	}
	for _, cancel := range a.workCancels {
		cancel()
	}
	for _, cancel := range a.speechCancels {
		cancel()
	}
	for _, c := range a.pending {
		select {
		case c <- browserReply{Error: "companion connection closed", Code: "error"}:
		default:
		}
	}
	a.mu.Unlock()
}
func (a *App) emit(typ string, payload any, runID, actionID string) error {
	b, e := json.Marshal(payload)
	if e != nil {
		return e
	}
	return a.Send(native.Message{Version: 1, ID: core.ID(), Type: typ, RunID: runID, ActionID: actionID, Payload: b})
}
func (a *App) Handle(m native.Message) {
	if m.Type == "browser.result" {
		var p struct {
			RequestID string         `json:"requestId"`
			Result    map[string]any `json:"result"`
			Error     string         `json:"error"`
			Code      string         `json:"code"`
		}
		if json.Unmarshal(m.Payload, &p) != nil {
			return
		}
		a.mu.Lock()
		c := a.pending[p.RequestID]
		a.mu.Unlock()
		if c != nil {
			select {
			case c <- browserReply{p.Result, p.Error, p.Code}:
			default:
			}
		}
		return
	}
	go func() {
		result, e := a.dispatch(m)
		reply := map[string]any{"requestId": m.ID, "result": result}
		if e != nil {
			reply["error"] = e.Error()
		}
		_ = a.emit("rpc.result", reply, m.RunID, "")
	}()
}
func (a *App) browser(ctx context.Context, runID, actionID string, payload any) (map[string]any, error) {
	id := core.ID()
	c := make(chan browserReply, 1)
	a.mu.Lock()
	if a.closing {
		a.mu.Unlock()
		return nil, errors.New("companion closing")
	}
	a.pending[id] = c
	a.mu.Unlock()
	defer func() { a.mu.Lock(); delete(a.pending, id); a.mu.Unlock() }()
	b, _ := json.Marshal(payload)
	if e := a.Send(native.Message{Version: 1, ID: id, Type: "browser.request", RunID: runID, ActionID: actionID, Payload: b}); e != nil {
		return nil, e
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case r := <-c:
		if r.Error != "" {
			return r.Result, &BrowserError{Code: r.Code, Message: r.Error}
		}
		return r.Result, nil
	}
}

type BrowserError struct{ Code, Message string }

func (e *BrowserError) Error() string { return e.Message }
func (a *App) key() string {
	if k := os.Getenv("OPENAI_API_KEY"); k != "" {
		return k
	}
	b, e := os.ReadFile(filepath.Join(a.Store.Dir, "api-key.dpapi"))
	if e != nil {
		return ""
	}
	b, e = secrets.Unprotect(b)
	if e != nil {
		return ""
	}
	return string(b)
}
func (a *App) getSettings() core.Settings {
	a.mu.Lock()
	s := a.settings
	a.mu.Unlock()
	s.APIKey = ""
	s.TTSAPIKey = ""
	s.HasAPIKey = a.key() != ""
	s.HasTTSAPIKey = a.dedicatedTTSKey() != ""
	return s
}
func decode(m native.Message, v any) error { return json.Unmarshal(m.Payload, v) }
func (a *App) dispatch(m native.Message) (any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if m.Type == "plan.propose" || m.Type == "audio.complete" {
		a.mu.Lock()
		a.workCancels[m.ID] = cancel
		a.mu.Unlock()
		defer func() { a.mu.Lock(); delete(a.workCancels, m.ID); a.mu.Unlock() }()
	}
	switch m.Type {
	case "hello":
		return map[string]any{"version": 1, "hostVersion": "0.1.0", "settings": a.getSettings(), "capabilities": []string{"dom", "input", "assertions", "accessibility", "visual", "voice", "reports"}}, nil
	case "settings.get":
		return a.getSettings(), nil
	case "settings.save":
		a.mu.Lock()
		active := a.activeID != ""
		a.mu.Unlock()
		if active {
			return nil, errors.New("finish or cancel the active run before changing settings")
		}
		p := a.getSettings()
		if e := decode(m, &p); e != nil {
			return nil, e
		}
		if p.Model == "" || p.TranscriptionModel == "" || len(p.MaskSelectors) > 2000 {
			return nil, errors.New("invalid settings")
		}
		if e := validateSpeechSettings(p); e != nil {
			return nil, e
		}
		if p.APIKey != "" {
			b, e := secrets.Protect([]byte(p.APIKey))
			if e != nil {
				return nil, e
			}
			if e = os.WriteFile(filepath.Join(a.Store.Dir, "api-key.dpapi"), b, 0600); e != nil {
				return nil, e
			}
		}
		p.APIKey = ""
		p.HasAPIKey = false
		if p.TTSAPIKey != "" {
			if e := a.saveSecret("tts-api-key.dpapi", p.TTSAPIKey); e != nil {
				return nil, e
			}
		}
		p.TTSAPIKey = ""
		p.HasTTSAPIKey = false
		a.mu.Lock()
		a.settings = p
		a.mu.Unlock()
		return a.getSettings(), a.Store.Put("settings", "default", p)
	case "project.configure":
		var p struct {
			Origin string `json:"origin"`
			URL    string `json:"url"`
		}
		if e := decode(m, &p); e != nil {
			return nil, e
		}
		if !core.AllowedURL(p.URL, p.Origin) {
			return nil, errors.New("invalid project origin")
		}
		return p, a.Store.Put("project", p.Origin, p)
	case "plan.propose":
		var p struct {
			Request    string `json:"request"`
			URL        string `json:"url"`
			Origin     string `json:"origin"`
			Demo       bool   `json:"demo"`
			Responsive bool   `json:"responsive"`
			Visual     bool   `json:"visual"`
		}
		if e := decode(m, &p); e != nil {
			return nil, e
		}
		if len(p.Request) < 3 || len(p.Request) > 8000 || !core.AllowedURL(p.URL, p.Origin) {
			return nil, errors.New("select a valid target and describe a test")
		}
		var project any
		if e := a.Store.Get("project", p.Origin, &project); e != nil {
			return nil, errors.New("configure this target before proposing tests")
		}
		plan := core.Plan{}
		if p.Demo {
			u, _ := url.Parse(p.URL)
			if u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" {
				return nil, errors.New("fixture demo is restricted to the local demo shop")
			}
			obs, e := a.browser(ctx, "", "", map[string]any{"operation": "observe", "origin": p.Origin})
			if e != nil {
				return nil, e
			}
			if obs["fixture"] != "voiceqa-shop-v1" {
				return nil, errors.New("open the VoiceQA demo shop before using its fixture plan")
			}
			plan = provider.DemoPlan(p.URL, p.Origin, p.Request)
		} else {
			obs, e := a.browser(ctx, "", "", map[string]any{"operation": "observe", "origin": p.Origin})
			if e != nil {
				return nil, e
			}
			s := a.getSettings()
			raw, usage, e := a.Provider.Structured(ctx, a.key(), s.Model, provider.PlanInstructions, map[string]any{"request": p.Request, "url": p.URL, "approvedOrigin": p.Origin, "observation": obs}, provider.PlanSchema())
			if e != nil {
				return nil, e
			}
			if e = json.Unmarshal(raw, &plan); e != nil {
				return nil, e
			}
			plan.ID = core.ID()
			plan.Version = 1
			plan.URL = p.URL
			plan.Origin = p.Origin
			plan.Request = p.Request
			plan.Model = s.Model
			plan.Usage = usage
			plan.CreatedAt = core.Now()
			plan.Viewports = []core.Viewport{{Width: 1440, Height: 900}}
			if p.Responsive {
				plan.Viewports = append(plan.Viewports, core.Viewport{Width: 390, Height: 844})
			}
			for i := range plan.Cases {
				plan.Cases[i].Source = "agent-proposed; requires confirmation"
			}
		}
		plan.Visual = p.Visual
		if plan.Clarification == "" {
			if e := core.ValidatePlan(plan); e != nil {
				return nil, fmt.Errorf("generated plan rejected: %w", e)
			}
		}
		return plan, a.Store.Put("plan", plan.ID, plan)
	case "plan.confirm":
		var p struct {
			ID      string `json:"id"`
			Version int    `json:"version"`
		}
		if e := decode(m, &p); e != nil {
			return nil, e
		}
		var plan core.Plan
		if e := a.Store.Get("plan", p.ID, &plan); e != nil {
			return nil, e
		}
		if p.Version != plan.Version {
			return nil, errors.New("plan version changed")
		}
		if e := core.ValidatePlan(plan); e != nil {
			return nil, e
		}
		plan.Confirmed = true
		return plan, a.Store.Put("plan", plan.ID, plan)
	case "plan.list":
		return a.planList()
	case "plan.get":
		var p struct {
			ID string `json:"id"`
		}
		if e := decode(m, &p); e != nil {
			return nil, e
		}
		var plan core.Plan
		return &plan, a.Store.Get("plan", p.ID, &plan)
	case "run.start":
		return a.start(m)
	case "run.cancel":
		a.mu.Lock()
		active := a.activeID
		if m.RunID != "" && m.RunID != active {
			a.mu.Unlock()
			return nil, errors.New("run ID is not active")
		}
		if a.cancel != nil {
			a.cancel()
		}
		for _, cancel := range a.workCancels {
			cancel()
		}
		for _, cancel := range a.speechCancels {
			cancel()
		}
		a.mu.Unlock()
		return map[string]any{"runId": active, "cancelled": true}, nil
	case "run.get":
		var p struct {
			ID string `json:"id"`
		}
		if e := decode(m, &p); e != nil {
			return nil, e
		}
		var r core.Run
		if e := a.Store.Get("run", p.ID, &r); e != nil {
			return nil, e
		}
		return wireRun(r), nil
	case "run.list":
		return a.runList()
	case "upload.begin", "upload.chunk", "upload.complete":
		return a.handleUpload(m)
	case "artifact.get":
		var p struct {
			ID     string `json:"id"`
			Offset int    `json:"offset"`
		}
		if e := decode(m, &p); e != nil {
			return nil, e
		}
		b, e := a.Store.ReadArtifact(p.ID)
		if e != nil {
			return nil, e
		}
		if p.Offset < 0 || p.Offset > len(b) {
			return nil, errors.New("invalid offset")
		}
		end := min(p.Offset+192*1024, len(b))
		return map[string]any{"data": base64.StdEncoding.EncodeToString(b[p.Offset:end]), "next": end, "done": end == len(b)}, nil
	case "audio.complete":
		var p struct {
			ArtifactID string `json:"artifactId"`
			MIME       string `json:"mime"`
		}
		if e := decode(m, &p); e != nil {
			return nil, e
		}
		if !strings.HasPrefix(p.MIME, "audio/") {
			return nil, errors.New("invalid audio type")
		}
		b, e := a.Store.ReadArtifact(p.ArtifactID)
		if e != nil {
			return nil, e
		}
		defer os.Remove(a.Store.Artifact(p.ArtifactID))
		s := a.getSettings()
		t, e := a.Provider.Transcribe(ctx, a.key(), s.TranscriptionModel, p.MIME, b)
		return map[string]any{"text": t}, e
	case "speech.synthesize":
		return a.synthesize(ctx, m)
	case "speech.cancel":
		var p struct {
			SpeechID string `json:"speechId"`
		}
		if e := decode(m, &p); e != nil {
			return nil, e
		}
		if p.SpeechID == "" || len(p.SpeechID) > 128 {
			return nil, errors.New("invalid speech ID")
		}
		a.mu.Lock()
		for id, at := range a.speechCancelled {
			if time.Since(at) > 2*time.Minute {
				delete(a.speechCancelled, id)
			}
		}
		if len(a.speechCancelled) >= 256 {
			a.mu.Unlock()
			return nil, errors.New("too many pending speech cancellations")
		}
		a.speechCancelled[p.SpeechID] = time.Now()
		if cancel := a.speechCancels[p.SpeechID]; cancel != nil {
			cancel()
		}
		a.mu.Unlock()
		return map[string]any{"cancelled": true}, nil
	case "speech.release":
		return a.releaseSpeech(m)
	case "baseline.approve":
		return a.approveBaseline(m)
	case "report.export":
		return a.exportReport(m)
	default:
		return nil, errors.New("unsupported RPC: " + m.Type)
	}
}
