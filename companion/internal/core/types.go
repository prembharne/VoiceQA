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
	AIProvider         string `json:"aiProvider"`
	SpeechAPIKey       string `json:"speechApiKey,omitempty"`
	HasSpeechAPIKey    bool   `json:"hasSpeechApiKey"`
	Model              string `json:"model"`
	TranscriptionModel string `json:"transcriptionModel"`
	APIKey             string `json:"apiKey,omitempty"`
	HasAPIKey          bool   `json:"hasApiKey"`
	MaskSelectors      string `json:"maskSelectors"`
	TTSProvider        string `json:"ttsProvider"`
	TTSModel           string `json:"ttsModel"`
	TTSVoice           string `json:"ttsVoice"`
	TTSAPIKey          string `json:"ttsApiKey,omitempty"`
	HasTTSAPIKey       bool   `json:"hasTtsApiKey"`
	TTSReuseMainKey    bool   `json:"ttsReuseMainKey"`
	StepDelayMS        int    `json:"stepDelayMs"`
}
type Assertion struct {
	Kind      string  `json:"kind"`
	Expected  string  `json:"expected"`
	Tolerance float64 `json:"tolerance,omitempty"`
}
type Action struct {
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
type Plan struct {
	Pages         []Page         `json:"pages,omitempty"`
	AIProvider    string         `json:"aiProvider,omitempty"`
	ID            string         `json:"id"`
	Version       int            `json:"version"`
	Origin        string         `json:"origin"`
	URL           string         `json:"url"`
	Request       string         `json:"request"`
	Summary       string         `json:"summary"`
	Clarification string         `json:"clarification"`
	Cases         []Case         `json:"cases"`
	Viewports     []Viewport     `json:"viewports"`
	Confirmed     bool           `json:"confirmed"`
	Visual        bool           `json:"visual"`
	Model         string         `json:"model"`
	Usage         map[string]int `json:"usage,omitempty"`
	CreatedAt     string         `json:"createdAt"`
}
type Viewport struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}
type Step struct {
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
	Handoff     *Handoff       `json:"handoff,omitempty"`
	ID          string         `json:"id"`
	Plan        Plan           `json:"plan"`
	Status      string         `json:"status"`
	Steps       []Step         `json:"steps"`
	StartedAt   string         `json:"startedAt"`
	CompletedAt string         `json:"completedAt,omitempty"`
	Error       string         `json:"error,omitempty"`
	Usage       map[string]int `json:"usage"`
	DurationMS  int64          `json:"durationMs"`
	StepDelayMS int            `json:"stepDelayMs"`
	TotalSteps  int            `json:"totalSteps"`
	NextStep    *Step          `json:"nextStep,omitempty"`
	NextStepAt  string         `json:"nextStepAt,omitempty"`
}

var operations = map[string]bool{"navigate": true, "click": true, "fill": true, "select": true, "scroll": true, "key": true, "assert": true, "open_tab": true, "switch_tab": true, "close_tab": true, "wait_for": true, "fill_secret": true, "fill_totp": true, "human_checkpoint": true}
var assertions = map[string]bool{"text": true, "text_contains": true, "value": true, "visible": true, "hidden": true, "count": true, "enabled": true, "selected": true, "number": true, "url": true, "url_contains": true, "focus": true, "no_overflow": true}

func AllowedURL(raw, origin string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Scheme+"://"+u.Host == origin && u.User == nil
}
func ValidatePlan(p Plan) error {
	if !AllowedURL(p.URL, p.Origin) {
		return errors.New("plan must target an HTTP(S) URL in its approved origin")
	}
	if p.Clarification != "" {
		return errors.New("answer the clarification before confirming")
	}
	if len(p.Cases) == 0 || len(p.Cases) > 10 {
		return errors.New("plan must contain 1–10 test cases")
	}
	if len(p.Viewports) == 0 || len(p.Viewports) > 2 {
		return errors.New("select one or two viewports")
	}
	if _, e := NewScope(p, "main"); e != nil {
		return e
	}
	n := 0
	for _, v := range p.Viewports {
		if v.Width < 320 || v.Width > 1920 || v.Height < 400 || v.Height > 1200 {
			return errors.New("viewport is out of bounds")
		}
	}
	for caseIndex, c := range p.Cases {
		if strings.TrimSpace(c.Name) == "" || len(c.Steps) == 0 {
			return errors.New("each test needs a name and steps")
		}
		if c.Steps[0].Operation != "navigate" {
			return fmt.Errorf("case %d must start by navigating to its starting URL before any clicks or checks; steps must be in execution order", caseIndex+1)
		}
		checks := 0
		scope, e := NewScope(p, c.Page)
		if e != nil {
			return e
		}
		for stepIndex, a := range c.Steps {
			n++
			if !operations[a.Operation] || len(a.Target) > 500 || len(a.Value) > 4000 {
				return errors.New("invalid test action")
			}
			if e := scope.Advance(a); e != nil {
				return fmt.Errorf("case %d, step %d: %w", caseIndex+1, stepIndex+1, e)
			}
			if a.Operation == "key" && !strings.Contains("|Tab|Enter|Escape|ArrowDown|ArrowUp|Space|", "|"+a.Value+"|") {
				return errors.New("unsupported key")
			}
			if a.Operation == "assert" || a.Operation == "wait_for" {
				if a.Assertion == nil || !assertions[a.Assertion.Kind] || a.Assertion.Tolerance < 0 {
					return errors.New("invalid assertion")
				}
				if a.Operation == "assert" {
					checks++
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
						return fmt.Errorf("case %d, step %d (count): expected must be a nonnegative integer string", caseIndex+1, stepIndex+1)
					}
				}
				if (a.Assertion.Kind == "visible" || a.Assertion.Kind == "hidden" || a.Assertion.Kind == "enabled" || a.Assertion.Kind == "selected" || a.Assertion.Kind == "focus" || a.Assertion.Kind == "no_overflow") && a.Assertion.Expected != "true" && a.Assertion.Expected != "false" {
					return fmt.Errorf("case %d, step %d (%s): boolean assertion requires the string true or false", caseIndex+1, stepIndex+1, a.Assertion.Kind)
				}
			}
		}
		if checks == 0 {
			return fmt.Errorf("%s needs an independent assertion", c.Name)
		}
	}
	if n*len(p.Viewports) > 50 {
		return errors.New("plan exceeds the 50-action limit")
	}
	b, _ := json.Marshal(p)
	if len(b) > 128*1024 {
		return errors.New("plan exceeds encoded size limit")
	}
	return nil
}
