package core

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func ID() string  { b := make([]byte, 16); _, _ = rand.Read(b); return hex.EncodeToString(b) }
func Now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

type Settings struct {
	AIProvider          string `json:"aiProvider"`
	SpeechAPIKey        string `json:"speechApiKey,omitempty"`
	HasSpeechAPIKey     bool   `json:"hasSpeechApiKey"`
	Model               string `json:"model"`
	TranscriptionModel  string `json:"transcriptionModel"`
	APIKey              string `json:"apiKey,omitempty"`
	HasAPIKey           bool   `json:"hasApiKey"`
	MaskSelectors       string `json:"maskSelectors"`
	VisualMaskSelectors string `json:"visualMaskSelectors"`
	TTSProvider         string `json:"ttsProvider"`
	TTSModel            string `json:"ttsModel"`
	TTSVoice            string `json:"ttsVoice"`
	TTSAPIKey           string `json:"ttsApiKey,omitempty"`
	HasTTSAPIKey        bool   `json:"hasTtsApiKey"`
	TTSReuseMainKey     bool   `json:"ttsReuseMainKey"`
	StepDelayMS         int    `json:"stepDelayMs"`
}
type Assertion struct {
	Kind      string  `json:"kind"`
	Expected  string  `json:"expected"`
	Tolerance float64 `json:"tolerance,omitempty"`
}
type Action struct {
	HTTP      *HTTPCheck `json:"http,omitempty"`
	Operation string     `json:"operation"`
	Target    string     `json:"target,omitempty"`
	Value     string     `json:"value,omitempty"`
	Assertion *Assertion `json:"assertion,omitempty"`
	Label     string     `json:"label"`
	TimeoutMS int        `json:"timeoutMs,omitempty"`
}
type Case struct {
	Page   string   `json:"page,omitempty"`
	Name   string   `json:"name"`
	Goal   string   `json:"goal"`
	Source string   `json:"source"`
	Steps  []Action `json:"steps"`
}
type AutomationPolicy struct {
	Live               bool     `json:"live,omitempty"`
	MaxActions         int      `json:"maxActions"`
	AllowConsequential bool     `json:"allowConsequential"`
	Criteria           []string `json:"criteria"`
}
type Plan struct {
	Conversation       []map[string]string `json:"conversation,omitempty"`
	Automation         *AutomationPolicy   `json:"automation,omitempty"`
	APIWritesAllowed   bool                `json:"apiWritesAllowed,omitempty"`
	Mode               string              `json:"mode,omitempty"`
	SecurityAuthorized bool                `json:"securityAuthorized,omitempty"`
	Dataset            []map[string]string `json:"dataset,omitempty"`
	Pages              []Page              `json:"pages,omitempty"`
	AIProvider         string              `json:"aiProvider,omitempty"`
	ID                 string              `json:"id"`
	Version            int                 `json:"version"`
	Origin             string              `json:"origin"`
	URL                string              `json:"url"`
	Request            string              `json:"request"`
	Summary            string              `json:"summary"`
	Clarification      string              `json:"clarification"`
	Cases              []Case              `json:"cases"`
	Viewports          []Viewport          `json:"viewports"`
	PreserveViewport   bool                `json:"preserveViewport,omitempty"`
	Confirmed          bool                `json:"confirmed"`
	Visual             bool                `json:"visual"`
	Model              string              `json:"model"`
	Usage              map[string]int      `json:"usage,omitempty"`
	CreatedAt          string              `json:"createdAt"`
}
type Viewport struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}
type Step struct {
	Iteration   int            `json:"iteration,omitempty"`
	Page        string         `json:"page,omitempty"`
	ID          string         `json:"id"`
	Case        string         `json:"case"`
	Viewport    string         `json:"viewport"`
	Action      Action         `json:"action"`
	Status      string         `json:"status"`
	Result      map[string]any `json:"result,omitempty"`
	Error       string         `json:"error,omitempty"`
	StartedAt   string         `json:"startedAt"`
	CompletedAt string         `json:"completedAt,omitempty"`
}
type Run struct {
	DecisionErrors   []map[string]any  `json:"decisionErrors,omitempty"`
	Observations     []map[string]any  `json:"observations,omitempty"`
	EvidenceOmitted  bool              `json:"evidenceOmitted,omitempty"`
	AgentPhase       string            `json:"agentPhase,omitempty"`
	RecordedSteps    int               `json:"recordedSteps,omitempty"`
	PassedSteps      int               `json:"passedSteps,omitempty"`
	FailedSteps      int               `json:"failedSteps,omitempty"`
	OmittedSteps     int               `json:"omittedSteps,omitempty"`
	Values           map[string]string `json:"values,omitempty"`
	Iteration        int               `json:"iteration,omitempty"`
	Diagnosis        *Diagnosis        `json:"diagnosis,omitempty"`
	SecurityFindings []Finding         `json:"securityFindings,omitempty"`
	Handoff          *Handoff          `json:"handoff,omitempty"`
	ID               string            `json:"id"`
	Plan             Plan              `json:"plan"`
	Status           string            `json:"status"`
	Steps            []Step            `json:"steps"`
	StartedAt        string            `json:"startedAt"`
	CompletedAt      string            `json:"completedAt,omitempty"`
	Error            string            `json:"error,omitempty"`
	Usage            map[string]int    `json:"usage"`
	DurationMS       int64             `json:"durationMs"`
	StepDelayMS      int               `json:"stepDelayMs"`
	TotalSteps       int               `json:"totalSteps"`
	NextStep         *Step             `json:"nextStep,omitempty"`
	NextStepAt       string            `json:"nextStepAt,omitempty"`
}

var operations = map[string]bool{"navigate": true, "click": true, "fill": true, "select": true, "scroll": true, "key": true, "assert": true, "open_tab": true, "switch_tab": true, "close_tab": true, "wait_for": true, "fill_secret": true, "fill_totp": true, "human_checkpoint": true, "capture_value": true, "http_check": true, "security_audit": true}
var assertions = map[string]bool{"text": true, "text_contains": true, "value": true, "visible": true, "hidden": true, "count": true, "enabled": true, "selected": true, "number": true, "url": true, "url_contains": true, "focus": true, "no_overflow": true}

func AllowedURL(raw, origin string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Scheme+"://"+u.Host == origin && u.User == nil
}
func validateResolvedPlan(p Plan) error {
	if len(p.Conversation) > 6 {
		return errors.New("conversation context exceeds six turns")
	}
	for _, turn := range p.Conversation {
		if (turn["role"] != "user" && turn["role"] != "assistant") || len(turn["text"]) > 8000 {
			return errors.New("invalid conversation reference data")
		}
	}
	if len(p.URL) > 2000 || len(p.Request) > 8000 || len(p.Summary) > 2000 {
		return errors.New("plan URL, request or summary exceeds its size limit")
	}
	if p.Mode != "" && p.Mode != "qa" && p.Mode != "security" && p.Mode != "automation" {
		return errors.New("choose QA or logical security mode")
	}
	if p.Mode == "automation" && p.Automation == nil {
		return errors.New("automation mode requires a reviewed automation policy")
	}
	if p.Mode == "security" && !p.SecurityAuthorized {
		return errors.New("confirm authorization for the shared test systems before security testing")
	}
	if e := ValidateDataset(p.Dataset); e != nil {
		return e
	}
	if !AllowedURL(p.URL, p.Origin) {
		return errors.New("plan must target an HTTP(S) URL in its approved origin")
	}
	if p.Clarification != "" {
		return errors.New("answer the clarification before confirming")
	}
	if p.Automation != nil {
		return ValidateAutomationPlan(p)
	}
	if len(p.Cases) == 0 || len(p.Cases) > 10 {
		return errors.New("plan must contain 1–10 test cases")
	}
	if len(p.Viewports) == 0 || len(p.Viewports) > 2 {
		return errors.New("select one or two viewports")
	}
	if p.PreserveViewport && len(p.Viewports) != 1 {
		return errors.New("current-width plans use one viewport without responsive replay")
	}
	if _, e := NewScope(p, "main"); e != nil {
		return e
	}
	n := 0
	httpCount := 0
	for _, v := range p.Viewports {
		if p.PreserveViewport {
			if v.Width < 1 || v.Width > 16384 || v.Height < 1 || v.Height > 16384 {
				return errors.New("current viewport is out of bounds")
			}
			continue
		}
		if v.Width < 320 || v.Width > 1920 || v.Height < 400 || v.Height > 1200 {
			return errors.New("viewport is out of bounds")
		}
	}
	for caseIndex, c := range p.Cases {
		if strings.TrimSpace(c.Name) == "" {
			return fmt.Errorf("case %d needs a nonempty name", caseIndex+1)
		}
		if len(c.Name) > 100 || len(c.Goal) > 500 || len(c.Source) > 300 {
			return fmt.Errorf("case %d metadata exceeds its byte limits: name=%d/100, goal=%d/500, source=%d/300; shorten descriptions without removing test steps", caseIndex+1, len(c.Name), len(c.Goal), len(c.Source))
		}
		if len(c.Steps) == 0 {
			return fmt.Errorf("case %d needs executable steps", caseIndex+1)
		}
		if c.Steps[0].Operation != "navigate" {
			return fmt.Errorf("case %d must start by navigating to its starting URL before any clicks or checks; first operation was %q. Add navigate as steps[0]; steps must be in execution order", caseIndex+1, c.Steps[0].Operation)
		}
		checks := 0
		scope, e := NewScope(p, c.Page)
		if e != nil {
			return e
		}
		for stepIndex, a := range c.Steps {
			n++
			if err := ValidateScopedAction(p, scope, a); err != nil {
				return fmt.Errorf("case %d step %d: %w", caseIndex+1, stepIndex+1, err)
			}
			if a.Operation == "assert" || a.Operation == "http_check" {
				checks++
			}
			if a.Operation == "http_check" {
				httpCount++
			}
		}
		if checks == 0 {
			return fmt.Errorf("%s needs an independent assertion", c.Name)
		}
	}
	rows := len(p.Dataset)
	if rows == 0 {
		rows = 1
	}
	if httpCount*len(p.Viewports)*rows > 20 {
		return errors.New("plan exceeds twenty API checks across data rows and viewports")
	}
	limit := 50
	if rows > 1 {
		limit = 200
	}
	if n*len(p.Viewports)*rows > limit {
		return fmt.Errorf("plan exceeds the %d-action limit across data rows and viewports", limit)
	}
	b, _ := json.Marshal(p)
	if len(b) > 128*1024 {
		return errors.New("plan exceeds encoded size limit")
	}
	return nil
}

func ValidateScopedAction(p Plan, scope *Scope, a Action) error {
	if !operations[a.Operation] || len(a.Target) > 500 || len(a.Value) > 4000 || len(a.Label) > 300 {
		return errors.New("invalid test action")
	}
	if a.Operation != "http_check" && a.HTTP != nil {
		return errors.New("HTTP details belong only to HTTP check actions")
	}
	if e := scope.Advance(a); e != nil {
		return e
	}
	if a.Operation == "security_audit" && p.Mode != "security" {
		return errors.New("security audit requires logical security mode")
	}
	if a.Operation == "capture_value" && !ValidVariable(a.Value) {
		return errors.New("capture_value requires a bare public alias matching ^[a-z][a-z0-9_-]{0,31}$, never a CSRF/auth token. For CSRF remove the capture step and put csrfSource=meta:OBSERVED_NAME with csrfHeader=DOCUMENTED_HEADER directly on the HTTP write")
	}
	if a.Operation == "http_check" {
		mode := p.Mode
		if p.APIWritesAllowed {
			mode = "security"
		}
		if e := ValidateHTTP(a.HTTP, mode, scope); e != nil {
			return fmt.Errorf("http_check: %w", e)
		}
	}
	if a.Operation == "key" && !strings.Contains("|Tab|Enter|Escape|ArrowDown|ArrowUp|Space|", "|"+a.Value+"|") {
		return errors.New("unsupported key")
	}
	if strings.HasPrefix(a.Target, "role:") {
		role, name, ok := strings.Cut(strings.TrimPrefix(a.Target, "role:"), "|")
		if !ok || strings.TrimSpace(role) == "" || strings.TrimSpace(name) == "" {
			return fmt.Errorf("malformed role target %q; use an observed selector or role:ROLE|EXACT ACCESSIBLE NAME", a.Target)
		}
	}
	if a.Operation == "assert" || a.Operation == "wait_for" {
		if a.Assertion == nil || !assertions[a.Assertion.Kind] || a.Assertion.Tolerance < 0 {
			return fmt.Errorf("%s: assertion must contain a supported kind, string expected and nonnegative tolerance; wait_for requires a readiness condition too", a.Operation)
		}
		if strings.TrimSpace(a.Target) == "" && a.Assertion.Kind != "url" && a.Assertion.Kind != "url_contains" && a.Assertion.Kind != "no_overflow" {
			return fmt.Errorf("%s: %s requires a nonempty element target; use an observed result selector, heading or status target", a.Operation, a.Assertion.Kind)
		}
		if a.Assertion.Kind == "number" {
			n, e := strconv.ParseFloat(a.Assertion.Expected, 64)
			if e != nil || math.IsNaN(n) || math.IsInf(n, 0) {
				return errors.New("numeric assertion requires a finite expected number")
			}
		}
		if a.Assertion.Kind == "count" {
			count, e := strconv.Atoi(a.Assertion.Expected)
			if e != nil || count < 0 {
				return fmt.Errorf("count: expected must be a nonnegative integer string")
			}
		}
		if (a.Assertion.Kind == "visible" || a.Assertion.Kind == "hidden" || a.Assertion.Kind == "enabled" || a.Assertion.Kind == "selected" || a.Assertion.Kind == "focus" || a.Assertion.Kind == "no_overflow") && a.Assertion.Expected != "true" && a.Assertion.Expected != "false" {
			return fmt.Errorf("%s: boolean assertion requires the string true or false", a.Assertion.Kind)
		}
	}
	return nil
}
