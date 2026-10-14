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

const HostVersion = "0.9.0"

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
	Store    *store.Store
	Provider *provider.Client
	// Optional protocol-harness observer. The desktop host never enables this.
	DraftDiagnostic func(int, core.Plan, error)
	Send            func(native.Message) error
	mu              sync.Mutex
	pending         map[string]chan browserReply
	uploads         map[string]*upload
	activeID        string
	cancel          context.CancelFunc
	settings        core.Settings
	workCancels     map[string]context.CancelFunc
	workGeneration  uint64
	speechCancels   map[string]context.CancelFunc
	speechCancelled map[string]time.Time
	closing         bool
}

func New(s *store.Store, send func(native.Message) error) *App {
	a := &App{Store: s, Provider: provider.New(), Send: send, pending: map[string]chan browserReply{}, uploads: map[string]*upload{}, workCancels: map[string]context.CancelFunc{}, speechCancels: map[string]context.CancelFunc{}, speechCancelled: map[string]time.Time{}}
	a.settings = defaultSettings()
	_ = s.Get("settings", "default", &a.settings)
	var savedSettings map[string]json.RawMessage
	_ = s.Get("settings", "default", &savedSettings)
	if len(savedSettings["aiProvider"]) == 0 && a.settings.AIProvider == "openai" && strings.HasPrefix(a.storedKey("api-key.dpapi"), "sk-or-") {
		a.settings.AIProvider = "openrouter"
		a.settings.Model = "openai/gpt-4o"
		_ = s.Put("settings", "default", a.settings)
	}
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
	var generation *uint64
	if m.Type == "plan.propose" || m.Type == "agent.query" || m.Type == "automation.propose" || m.Type == "audio.complete" {
		a.mu.Lock()
		value := a.workGeneration
		generation = &value
		a.mu.Unlock()
	}
	go func() {
		result, e := a.dispatchWork(m, generation)
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
func (a *App) storedKey(filename string) string {
	b, e := os.ReadFile(filepath.Join(a.Store.Dir, filename))
	if e != nil {
		return ""
	}
	b, e = secrets.Unprotect(b)
	if e != nil {
		return ""
	}
	return string(b)
}
func (a *App) keyFor(providerName string) string {
	if providerName == "nvidia" {
		if key := os.Getenv("NVIDIA_API_KEY"); key != "" {
			return key
		}
		return a.storedKey("nvidia-api-key.dpapi")
	}
	if providerName == "openrouter" {
		if k := os.Getenv("OPENROUTER_API_KEY"); k != "" {
			return k
		}
		if k := a.storedKey("openrouter-api-key.dpapi"); k != "" {
			return k
		}
		// Recover OpenRouter keys entered before provider selection existed.
		if k := a.storedKey("api-key.dpapi"); strings.HasPrefix(k, "sk-or-") {
			return k
		}
		return ""
	}
	k := os.Getenv("OPENAI_API_KEY")
	if k == "" {
		k = a.storedKey("api-key.dpapi")
	}
	if strings.HasPrefix(k, "sk-or-") || strings.HasPrefix(k, "nvapi-") {
		return ""
	}
	return k
}
func (a *App) speechKey() string {
	if k := a.storedKey("speech-api-key.dpapi"); k != "" && !strings.HasPrefix(k, "sk-or-") {
		return k
	}
	return a.keyFor("openai")
}
func (a *App) aiClient(name string) *provider.Client { return a.Provider.ForProvider(name) }
func (a *App) getSettings() core.Settings {
	a.mu.Lock()
	s := a.settings
	a.mu.Unlock()
	s.APIKey = ""
	s.SpeechAPIKey = ""
	s.HasSpeechAPIKey = a.speechKey() != ""
	s.TTSAPIKey = ""
	s.HasAPIKey = a.keyFor(s.AIProvider) != ""
	s.HasTTSAPIKey = a.dedicatedTTSKey() != ""
	return s
}
func decode(m native.Message, v any) error { return json.Unmarshal(m.Payload, v) }
func (a *App) dispatch(m native.Message) (any, error) {
	return a.dispatchWork(m, nil)
}
func (a *App) dispatchWork(m native.Message, generation *uint64) (any, error) {
	timeout := 2 * time.Minute
	if m.Type == "plan.propose" || m.Type == "agent.query" || m.Type == "automation.propose" {
		timeout = provider.PlanningTimeout + time.Minute
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if m.Type == "plan.propose" || m.Type == "agent.query" || m.Type == "automation.propose" || m.Type == "audio.complete" {
		a.mu.Lock()
		if a.closing || (generation != nil && *generation != a.workGeneration) {
			a.mu.Unlock()
			return nil, planningError(context.Canceled)
		}
		a.workCancels[m.ID] = cancel
		a.mu.Unlock()
		defer func() { a.mu.Lock(); delete(a.workCancels, m.ID); a.mu.Unlock() }()
	}
	switch m.Type {
	case "hello":
		return map[string]any{"version": 1, "hostVersion": HostVersion, "settings": a.getSettings(), "capabilities": []string{"agent-tools", "qa-answers", "linked-discovery", "dom", "input", "assertions", "accessibility", "visual", "voice", "reports", "multi-tab", "totp", "human-checkpoints", "condition-waits", "test-data", "workflow-variables", "http-checks", "logical-security", "network-evidence", "triage", "run-comparison"}}, nil
	case "auth.list", "auth.save", "auth.delete":
		return a.authDispatch(m)
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
		if p.Model == "" || p.TranscriptionModel == "" || len(p.MaskSelectors) > 2000 || len(p.VisualMaskSelectors) > 2000 {
			return nil, errors.New("invalid settings")
		}
		if p.StepDelayMS != 0 && (p.StepDelayMS < 3000 || p.StepDelayMS > 5000) {
			return nil, errors.New("step gap must be 3–5 seconds, or 0 for fast automation")
		}
		p.APIKey = strings.TrimSpace(p.APIKey)
		p.SpeechAPIKey = strings.TrimSpace(p.SpeechAPIKey)
		p.TTSAPIKey = strings.TrimSpace(p.TTSAPIKey)
		if strings.HasPrefix(p.SpeechAPIKey, "nvapi-") || strings.HasPrefix(p.TTSAPIKey, "nvapi-") {
			return nil, errors.New("NVIDIA NIM keys cannot be used for OpenAI speech")
		}
		if p.AIProvider != "openai" && p.AIProvider != "openrouter" && p.AIProvider != "nvidia" {
			return nil, errors.New("choose OpenAI, OpenRouter or NVIDIA NIM as the AI provider")
		}
		if p.AIProvider == "openrouter" && !strings.Contains(p.Model, "/") {
			return nil, errors.New("OpenRouter requires a full model ID, such as openai/gpt-4o")
		}
		if p.AIProvider == "nvidia" && !strings.Contains(p.Model, "/") {
			return nil, errors.New("NVIDIA NIM requires a full model ID")
		}
		if p.APIKey != "" {
			if err := a.aiClient(p.AIProvider).ValidateKey(p.APIKey); err != nil {
				return nil, err
			}
		}
		if (p.AIProvider == "openai" && strings.HasPrefix(p.APIKey, "sk-or-")) || strings.HasPrefix(p.SpeechAPIKey, "sk-or-") || strings.HasPrefix(p.TTSAPIKey, "sk-or-") {
			return nil, errors.New("OpenRouter keys can only be used with the OpenRouter AI provider, not OpenAI speech")
		}
		if e := validateSpeechSettings(p); e != nil {
			return nil, e
		}
		if p.APIKey != "" {
			filename := "api-key.dpapi"
			if p.AIProvider == "openrouter" {
				filename = "openrouter-api-key.dpapi"
			}
			if p.AIProvider == "nvidia" {
				filename = "nvidia-api-key.dpapi"
			}
			if e := a.saveSecret(filename, strings.TrimSpace(p.APIKey)); e != nil {
				return nil, e
			}
		}
		if p.SpeechAPIKey != "" {
			if e := a.saveSecret("speech-api-key.dpapi", strings.TrimSpace(p.SpeechAPIKey)); e != nil {
				return nil, e
			}
		}
		p.SpeechAPIKey = ""
		p.HasSpeechAPIKey = false
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
	case "automation.propose":
		return a.proposeAutomation(ctx, m)
	case "agent.query":
		var p struct {
			Request      string              `json:"request"`
			Origin       string              `json:"origin"`
			URL          string              `json:"url"`
			Pages        []core.Page         `json:"pages"`
			Conversation []map[string]string `json:"conversation"`
			ReadLinks    bool                `json:"readLinks"`
		}
		if err := decode(m, &p); err != nil {
			return nil, err
		}
		if strings.TrimSpace(p.Request) == "" || len(p.Request) > 8000 || len(p.Conversation) > 6 || !core.AllowedURL(p.URL, p.Origin) {
			return nil, errors.New("Invalid investigation request or scope")
		}
		if len(p.Pages) > 5 {
			return nil, errors.New("At most five pages may be investigated")
		}
		for _, page := range p.Pages {
			if !core.AllowedURL(page.URL, page.Origin) {
				return nil, errors.New("Invalid shared-page origin")
			}
		}
		for _, turn := range p.Conversation {
			if (turn["role"] != "user" && turn["role"] != "assistant") || len(turn["text"]) > 8000 {
				return nil, errors.New("Invalid investigation history")
			}
		}
		obs, err := a.browser(ctx, "", "", map[string]any{"operation": "observe", "origin": p.Origin})
		if err != nil {
			return nil, err
		}
		return a.investigate(ctx, p.Request, p.Origin, p.Pages, obs, p.Conversation, p.ReadLinks, m.ID)
	case "plan.propose":
		var p struct {
			Pages              []core.Page         `json:"pages"`
			Conversation       []map[string]string `json:"conversation"`
			Mode               string              `json:"mode"`
			APIWritesAllowed   bool                `json:"apiWritesAllowed"`
			SecurityAuthorized bool                `json:"securityAuthorized"`
			Dataset            []map[string]string `json:"dataset"`
			Request            string              `json:"request"`
			URL                string              `json:"url"`
			Origin             string              `json:"origin"`
			Demo               bool                `json:"demo"`
			Discover           bool                `json:"discover"`
			ReadLinks          bool                `json:"readLinks"`
			Responsive         bool                `json:"responsive"`
			Visual             bool                `json:"visual"`
		}
		if e := decode(m, &p); e != nil {
			return nil, e
		}
		if e := core.ValidateDataset(p.Dataset); e != nil {
			return nil, e
		}
		if p.Mode != "" && p.Mode != "qa" && p.Mode != "security" {
			return nil, errors.New("choose QA or logical security mode")
		}
		if p.Mode == "security" && !p.SecurityAuthorized {
			return nil, errors.New("confirm authorization for these shared test systems before security planning")
		}
		if len(p.Request) < 3 || len(p.Request) > 8000 || !core.AllowedURL(p.URL, p.Origin) {
			return nil, errors.New("select a valid target and describe a test")
		}
		var project any
		if e := a.Store.Get("project", p.Origin, &project); e != nil {
			return nil, errors.New("configure this target before proposing tests")
		}
		scopePlan := core.Plan{URL: p.URL, Origin: p.Origin, Pages: p.Pages}
		if _, e := core.NewScope(scopePlan, "main"); e != nil {
			return nil, e
		}
		plan := core.Plan{}
		var observation map[string]any
		if p.Demo {
			u, _ := url.Parse(p.URL)
			if u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" {
				return nil, errors.New("fixture suites are restricted to local VoiceQA test applications")
			}
			obs, e := a.browser(ctx, "", "", map[string]any{"operation": "observe", "origin": p.Origin})
			observation = obs
			if e != nil {
				return nil, e
			}
			if obs["fixture"] != "voiceqa-shop-v1" && obs["fixture"] != "voiceqa-advanced-v1" && obs["fixture"] != "voiceqa-security-v1" && obs["fixture"] != "voiceqa-workflow-v1" && obs["fixture"] != "voiceqa-workspace-v1" && obs["fixture"] != "voiceqa-workspace-auth-v1" && obs["fixture"] != "voiceqa-workspace-layout-v1" {
				return nil, errors.New("open a VoiceQA test application before using its fixture suite")
			}
			if obs["fixture"] == "voiceqa-workspace-v1" {
				if p.Mode == "security" {
					plan = provider.WorkspaceSecurityPlan(p.URL, p.Origin, p.Request, p.SecurityAuthorized)
				} else {
					plan = provider.WorkspaceDemoPlan(p.URL, p.Origin, p.Request)
				}
			} else if obs["fixture"] == "voiceqa-workspace-layout-v1" {
				plan = provider.WorkspaceLayoutPlan(p.URL, p.Origin, p.Request)
			} else if obs["fixture"] == "voiceqa-workspace-auth-v1" {
				profiles, _ := a.authList()
				profile := ""
				for _, entry := range profiles {
					if entry.Origin == p.Origin && entry.HasUsername && entry.HasPassword && entry.HasTOTP {
						profile = entry.ID
						break
					}
				}
				plan = provider.WorkspaceAuthPlan(p.URL, p.Origin, p.Request, profile)
			} else if obs["fixture"] == "voiceqa-security-v1" {
				plan = provider.SecurityDemoPlan(p.URL, p.Origin, p.Request, p.Mode == "security" && p.SecurityAuthorized)
			} else if obs["fixture"] == "voiceqa-workflow-v1" {
				plan = provider.WorkflowDemoPlan(p.URL, p.Origin, p.Request)
			} else if obs["fixture"] == "voiceqa-advanced-v1" {
				profiles, _ := a.authList()
				profile := ""
				for _, entry := range profiles {
					if entry.Origin == p.Origin && entry.HasUsername && entry.HasPassword && entry.HasTOTP {
						profile = entry.ID
						break
					}
				}
				plan = provider.AdvancedDemoPlan(p.URL, p.Origin, p.Request, profile)
			} else {
				plan = provider.DemoPlan(p.URL, p.Origin, p.Request)
			}
		} else {
			obs, e := a.browser(ctx, "", "", map[string]any{"operation": "observe", "origin": p.Origin})
			observation = obs
			if e != nil {
				return nil, e
			}
			extra := map[string]any{}
			for _, page := range p.Pages {
				if page.Alias == "main" {
					continue
				}
				view, err := a.browser(ctx, "", "", map[string]any{"operation": "observe_page", "page": page.Alias, "origin": p.Origin})
				if err != nil {
					return nil, err
				}
				extra[page.Alias] = view
			}
			obs["additionalPages"] = extra
			if len(p.Conversation) > 6 {
				return nil, errors.New("chat context allows at most six turns")
			}
			conversation := make([]map[string]string, 0, len(p.Conversation))
			for _, turn := range p.Conversation {
				if (turn["role"] != "user" && turn["role"] != "assistant") || len(turn["text"]) > 8000 {
					return nil, errors.New("invalid chat context")
				}
				conversation = append(conversation, map[string]string{"role": turn["role"], "text": turn["text"]})
			}
			obs["conversation"] = conversation
			var discoveryUsage map[string]int
			if p.Discover {
				var discoveryCancel context.CancelFunc
				ctx, discoveryCancel = context.WithTimeout(ctx, provider.PlanningTimeout)
				defer discoveryCancel()
				discovery, err := a.investigate(ctx, "Discover the controls, linked pages and expected outcomes needed for this requested workflow before plan review. Do not execute the workflow. Request: "+p.Request, p.Origin, p.Pages, obs, conversation, p.ReadLinks, m.ID)
				if err != nil {
					return nil, err
				}
				if discovery.Clarification != "" {
					return nil, fmt.Errorf("Investigation needs an essential requirement: %s", discovery.Clarification)
				}
				obs["discoveredEvidence"] = discovery.Evidence
				obs["discoverySummary"] = discovery.Answer
				discoveryUsage = discovery.Usage
			}
			plan, e = a.draftPlanWithProgress(ctx, p.Request, p.URL, p.Origin, p.Responsive, obs, core.Plan{Mode: p.Mode, SecurityAuthorized: p.SecurityAuthorized, Dataset: p.Dataset, APIWritesAllowed: p.APIWritesAllowed}, func(progress provider.PlanProgress) {
				_ = a.emit("plan.progress", map[string]any{"requestId": m.ID, "phase": progress.Phase, "receivedChars": progress.ReceivedChars}, "", "")
			}, p.Pages...)
			if e != nil {
				return nil, e
			}
			for name, count := range discoveryUsage {
				if plan.Usage == nil {
					plan.Usage = map[string]int{}
				}
				plan.Usage[name] += count
			}
		}
		plan.Pages = p.Pages
		plan.Mode = p.Mode
		plan.APIWritesAllowed = p.APIWritesAllowed
		plan.SecurityAuthorized = p.SecurityAuthorized
		if len(p.Dataset) > 0 {
			plan.Dataset = p.Dataset
		}
		plan.Visual = p.Visual
		if !p.Responsive {
			plan.PreserveViewport = true
			plan.Viewports = []core.Viewport{observedViewport(observation)}
		}
		if plan.Clarification == "" {
			if e := core.ValidatePlan(plan); e != nil {
				return nil, fmt.Errorf("generated plan rejected: %w", e)
			}
		}
		if e := ctx.Err(); e != nil {
			return nil, planningError(e)
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
		a.workGeneration++
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
	case "run.compare":
		return a.compareRuns(m)
	case "plan.fork":
		var p struct {
			ID               string               `json:"id"`
			Dataset          *[]map[string]string `json:"dataset"`
			PreserveViewport bool                 `json:"preserveViewport"`
		}
		if e := decode(m, &p); e != nil {
			return nil, e
		}
		var plan core.Plan
		if e := a.Store.Get("plan", p.ID, &plan); e != nil {
			return nil, e
		}
		if p.Dataset != nil {
			plan.Dataset = *p.Dataset
		}
		if p.PreserveViewport {
			plan.PreserveViewport = true
			if len(plan.Viewports) > 0 {
				plan.Viewports = plan.Viewports[:1]
			}
		}
		plan.ID = core.ID()
		plan.Version = 1
		plan.CreatedAt = core.Now()
		plan.Confirmed = false
		if e := core.ValidatePlan(plan); e != nil {
			return nil, e
		}
		return plan, a.Store.Put("plan", plan.ID, plan)
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
		t, e := a.Provider.Transcribe(ctx, a.speechKey(), s.TranscriptionModel, p.MIME, b)
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
