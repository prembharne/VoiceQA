package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strings"
	"time"
	"voiceqa/companion/internal/agentharness"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/provider"
	"voiceqa/companion/internal/visualagent"

	"github.com/cloudwego/eino/schema"
)

const repairTool = "voiceqa_response_repair"
const visualTool = "voiceqa_visual_step"
const dotsModel = "dots-studio/dots-3-note-preview:free"
const fallbackModel = "qwen/qwen3.7-flash"

type automationSession struct {
	router                          progressRouter
	visual                          visualSession
	visualReply                     visualagent.Reply
	visualImage                     map[string]any
	visualTicket                    string
	visualTotal                     int
	visualDisabled                  bool
	app                             *App
	run                             *core.Run
	scope                           *core.Scope
	viewport                        string
	profiles                        []AuthProfile
	observation, public             map[string]any
	seen, readSeen                  map[string]bool
	readCalls, rejections           int
	waitRecoveries                  int
	pendingWaits                    map[string]bool
	validation, model               string
	contract                        any
	recoveries, domCooldown         int
	lastRecovery                    map[string]any
	recoveryTicket, pendingRecovery string
	uiRetries                       map[string]int
	notDispatched                   map[string]bool
	blockerReports                  int
}

func (a *App) runAutomationHarness(ctx context.Context, r *core.Run) error {
	a.update(r)
	if r.Status == "error" {
		return errors.New(r.Error)
	}
	scope, err := core.NewScope(r.Plan, "main")
	if err != nil {
		return err
	}
	view, err := a.browser(ctx, r.ID, "", map[string]any{"operation": "current_viewport", "origin": r.Plan.Origin})
	if err != nil {
		return err
	}
	profiles, err := a.authList()
	if err != nil {
		return err
	}
	v := observedViewport(view)
	s := &automationSession{app: a, run: r, scope: scope, viewport: fmt.Sprintf("%dx%d", v.Width, v.Height), seen: map[string]bool{}, readSeen: map[string]bool{}, model: r.Plan.Model}
	defer s.visual.close()
	for _, profile := range profiles {
		if scope.Approved[profile.Origin] {
			s.profiles = append(s.profiles, profile)
		}
	}
	if r.Usage == nil {
		r.Usage = map[string]int{}
	}
	r.Values = map[string]string{}
	r.AgentRuntime, r.AgentModel = agentharness.Runtime, s.model
	s.contract = s.decisionSchema()
	tools := []agentharness.Tool{}
	for _, def := range provider.DecisionTools(s.contract) {
		tools = append(tools, agentharness.Tool{Name: def.Name, Parameters: def.Parameters})
	}
	tools = append(tools, agentharness.Tool{Name: repairTool, Parameters: provider.Object(map[string]any{"error": provider.String()})})
	tools = append(tools, agentharness.Tool{Name: visualTool, Parameters: provider.Object(map[string]any{"ticket": provider.String()})})
	tools = append(tools, agentharness.Tool{Name: recoveryTool, Parameters: provider.Object(map[string]any{"ticket": provider.String()})})
	cfg := agentharness.Config{Instructions: provider.AutomationInstructions, Request: r.Plan.Request,
		MaxIterations: 3 * (r.Plan.Automation.MaxActions + automationReadBudget + 1), Tools: tools,
		Decide: func(ctx context.Context, messages []*schema.Message) (agentharness.Call, error) {
			return s.decide(ctx, messages, r.Plan.Model)
		}, Invoke: s.invoke,
	}
	// Only this particular paid fallback was authorized. Other selections never
	// silently switch to it. Saved provider/model settings stay intact.
	if r.Plan.AIProvider == "openrouter" && r.Plan.Model == dotsModel {
		cfg.FallbackDecide = func(ctx context.Context, messages []*schema.Message) (agentharness.Call, error) {
			return s.decide(ctx, messages, fallbackModel)
		}
		cfg.ShouldFailover = transientAgentProviderError
		cfg.OnFallback = func(err error) {
			s.providerEvent("model_fallback", fallbackModel, err)
			r.AgentPhase = "Dots unavailable; switching to authorized Qwen fallback"
			a.update(r)
		}
	}
	err = agentharness.Run(ctx, cfg)
	if r.Status != "running" {
		return nil
	}
	return err
}

func (s *automationSession) decisionSchema() any {
	if !s.run.Plan.Automation.Live {
		return provider.AutomationStepSchema(len(s.run.Plan.Automation.Criteria))
	}
	aliases := []string{""}
	for alias := range s.scope.Origins {
		aliases = append(aliases, alias)
	}
	sort.Strings(aliases)
	return provider.AutomationLiveStepSchema(aliases...)
}

func (s *automationSession) event(kind, name string) {
	r := s.run
	if len(r.AgentEvents) < 180 {
		r.AgentEvents = append(r.AgentEvents, map[string]any{"kind": kind, "name": name, "afterActions": len(r.Steps), "at": core.Now()})
	}
}

func (s *automationSession) providerEvent(kind, name string, err error) {
	before := len(s.run.AgentEvents)
	s.event(kind, name)
	if len(s.run.AgentEvents) == before {
		return
	}
	event := s.run.AgentEvents[before]
	var status *provider.StatusError
	var empty *provider.EmptyResultError
	var network net.Error
	switch {
	case errors.As(err, &status):
		event["failureClass"], event["providerStatus"] = "provider_status", status.Status
	case errors.As(err, &empty):
		event["failureClass"] = "empty_result"
	case errors.Is(err, context.DeadlineExceeded):
		event["failureClass"] = "deadline"
	case errors.Is(err, context.Canceled):
		event["failureClass"] = "canceled"
	case errors.As(err, &network):
		event["failureClass"] = "network"
	default:
		event["failureClass"] = "provider_response"
	}
}

func (s *automationSession) decide(ctx context.Context, messages []*schema.Message, selected string) (agentharness.Call, error) {
	a, r := s.app, s.run
	if len(r.Steps) >= r.Plan.Automation.MaxActions {
		return agentharness.Call{}, &BrowserError{Code: "blocked", Message: "Automation action budget exhausted before verified completion"}
	}
	if err := ctx.Err(); err != nil {
		return agentharness.Call{}, err
	}
	r.AgentModel, s.model = selected, selected
	r.AgentPhase = "Observing the current page"
	a.update(r)
	if r.Status == "error" {
		return agentharness.Call{}, errors.New(r.Error)
	}
	obs, err := a.browser(ctx, r.ID, "", map[string]any{"operation": "observe", "origin": r.Plan.Origin})
	if err != nil {
		return agentharness.Call{}, err
	}
	s.observation, s.public = obs, agentPublicEvidence(obs)
	rememberAutomationObservation(r, s.public)
	s.router.observe(s.public)
	visualAllowed := !s.visualDisabled && s.visualTotal < r.Plan.Automation.MaxActions
	reason := s.router.reason(visualAllowed && a.visualAvailable(r.Plan.AIProvider, r.Plan.Model), s.rejections > 0, automationReadBudget-s.readCalls)
	if s.domCooldown > 0 {
		s.domCooldown--
		reason, s.router.visual = "", false
	}
	if visualAllowed && (s.router.visual || reason != "") {
		if s.router.visualTurns >= 6 {
			s.router.visual = false
			s.router.unchanged = 0
			s.router.reads = 0
			s.router.visualTurns = 0
		} else {
			s.visualTotal++
			s.router.visual = true
			ticket, visualErr := s.visualDecision(ctx, reason)
			if visualErr != nil {
				var unavailable *BrowserError
				if errors.As(visualErr, &unavailable) && unavailable.Code == "visual_unavailable" {
					s.visualDisabled = true // DOM tools remain usable in this viewport.
				}
				if recoverableVisualDecision(ctx, visualErr) {
					s.visual.close()
					return s.queueRecovery(visualErr), nil
				}
				return agentharness.Call{}, visualErr
			}
			args, _ := json.Marshal(map[string]string{"ticket": ticket})
			return agentharness.Call{Name: visualTool, Arguments: string(args)}, nil
		}
	}
	history := r.Steps
	if len(history) > 12 {
		history = history[len(history)-12:]
	}
	input := map[string]any{"goal": r.Plan.Request, "conversation": r.Plan.Conversation, "successCriteria": r.Plan.Automation.Criteria, "permissions": r.Plan.Automation, "apiWritesAllowed": r.Plan.APIWritesAllowed, "scope": s.scope, "observation": automationModelObservation(s.public), "navigationChoices": automationNavigationChoices(s.scope, obs), "observedStateHistory": automationModelHistory(r.Observations), "readEvidence": r.ReadEvidence, "earlierEvidenceOmitted": r.EvidenceOmitted, "recentSteps": agentPublicEvidence(map[string]any{"steps": history})["steps"], "publicValues": r.Values, "credentialProfiles": s.profiles, "remainingActions": r.Plan.Automation.MaxActions - len(r.Steps), "remainingReadCalls": automationReadBudget - s.readCalls, "validationError": s.validation}
	input["goalRecovery"] = s.lastRecovery
	input["goalState"] = map[string]any{"completedActions": len(r.Steps), "recordedFailures": automationHasFailures(r), "recoveryAttempts": s.recoveries, "completion": "Requires independent outcome checks covering the original goal"}
	// Keep Eino's latest tool feedback; durable public facts live in the evidence
	// ledger instead of being duplicated in an ever-growing transcript.
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == schema.Tool {
			input["lastToolFeedback"] = messages[i].Content
			break
		}
	}
	s.contract = s.decisionSchema()
	r.AgentPhase = "Waiting for AI provider"
	a.update(r)
	if r.Status == "error" {
		return agentharness.Call{}, errors.New(r.Error)
	}
	s.event("model_request", selected)
	// Per-decision deadline, no generation-token cap and no mutation retries.
	callCtx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	raw, usage, err := a.aiClient(r.Plan.AIProvider).ToolDecision(callCtx, a.keyFor(r.Plan.AIProvider), selected, provider.AutomationInstructions, input, s.contract, completedToolTurns(messages))
	for key, n := range usage {
		r.Usage[key] += n
	}
	if err != nil {
		s.providerEvent("model_error", selected, err)
	} else {
		s.event("model_response", selected)
	}
	a.update(r)
	if r.Status == "error" {
		return agentharness.Call{}, errors.New(r.Error)
	}
	if err != nil && !provider.IsResponseContractError(err) {
		return agentharness.Call{}, err
	}
	var packet struct {
		Result automationDecision `json:"result"`
	}
	if err == nil {
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		err = decoder.Decode(&packet)
	}
	if err == nil && packet.Result.Type != "tool" && (packet.Result.Name != "" || packet.Result.Args != (agentArgs{})) {
		err = errors.New("Read-tool fields cannot be mixed with an action or completion")
	}
	if err == nil && packet.Result.Type == "tool" && (packet.Result.Action != (core.Action{}) || len(packet.Result.Checks) > 0 || packet.Result.Message != "") {
		err = errors.New("Read tools cannot include mutation or completion fields")
	}
	if err != nil {
		args, _ := json.Marshal(map[string]string{"error": recordedText(err.Error(), 1200)})
		return agentharness.Call{Name: repairTool, Arguments: string(args)}, nil
	}
	name, arguments, err := provider.EncodeDecisionTool(s.contract, raw)
	if err != nil {
		args, _ := json.Marshal(map[string]string{"error": recordedText(err.Error(), 1200)})
		return agentharness.Call{Name: repairTool, Arguments: string(args)}, nil
	}
	return agentharness.Call{Name: name, Arguments: arguments}, nil
}

func (s *automationSession) reject(d automationDecision, err error) (agentharness.Outcome, error) {
	r := s.run
	s.rejections++
	s.validation = err.Error()
	if len(r.DecisionErrors) < 24 {
		r.DecisionErrors = append(r.DecisionErrors, map[string]any{"afterActions": len(r.Steps), "error": recordedText(s.validation, 1200), "candidate": recordedAutomationCandidate(d)})
	}
	s.event("rejected_before_dispatch", d.Type)
	s.app.update(r)
	if r.Status == "error" {
		return agentharness.Outcome{}, errors.New(r.Error)
	}
	return s.recoverGoal("proposal_rejected_before_dispatch", err, &d.Action, false)
}

func (s *automationSession) invoke(ctx context.Context, call agentharness.Call) (agentharness.Outcome, error) {
	a, r := s.app, s.run
	if err := ctx.Err(); err != nil {
		return agentharness.Outcome{}, err
	}
	if call.Name == visualTool {
		return s.invokeVisual(ctx, call)
	}
	if call.Name == recoveryTool {
		return s.invokeRecovery(call)
	}
	if call.Name == repairTool {
		var body struct {
			Error string `json:"error"`
		}
		if json.Unmarshal([]byte(call.Arguments), &body) != nil || body.Error == "" {
			return agentharness.Outcome{}, errors.New("invalid response-repair feedback")
		}
		return s.reject(automationDecision{}, errors.New(body.Error))
	}
	raw, err := provider.DecodeDecisionTool(s.contract, call.Name, call.Arguments)
	if err != nil {
		return s.reject(automationDecision{}, err)
	}
	var packet struct {
		Result automationDecision `json:"result"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&packet); err != nil {
		return s.reject(automationDecision{}, err)
	}
	d := packet.Result
	if d.Type == "action" && (d.Action.Operation == "assert" || d.Action.Operation == "wait_for") {
		s.router.unchanged = -1
	}
	if d.Type == "tool" {
		s.router.reads++
	} else {
		s.router.reads = 0
	}
	r.AgentPhase = "Validating AI decision"
	a.update(r)
	if r.Status == "error" {
		return agentharness.Outcome{}, errors.New(r.Error)
	}
	if err = s.validate(ctx, &d); err != nil {
		var measured *BrowserError
		if errors.As(err, &measured) && measured.Code == "assertion_failed" {
			return s.recoverGoal("recorded_regression", err, nil, false)
		}
		if ctx.Err() != nil || r.Status != "running" {
			return agentharness.Outcome{}, err
		}
		return s.reject(d, err)
	}
	s.event("tool_dispatch", call.Name)
	if err = s.execute(ctx, d); err != nil {
		return agentharness.Outcome{}, err
	}
	s.validation, s.rejections = "", 0
	result := map[string]any{"status": r.Status, "executedTool": call.Name, "recordedSteps": len(r.Steps)}
	if d.Type == "tool" && len(r.ReadEvidence) > 0 {
		result["readEvidenceId"] = r.ReadEvidence[len(r.ReadEvidence)-1]["id"]
		result["readEvidence"] = r.ReadEvidence[len(r.ReadEvidence)-1]
	}
	if d.Type == "action" && len(r.Steps) > 0 {
		result["step"] = recordedStepEvidence(r.Steps[len(r.Steps)-1])
	}
	s.event("tool_result", call.Name)
	a.update(r)
	return agentharness.Outcome{Output: result, Stop: r.Status != "running"}, nil
}

func completedToolTurns(messages []*schema.Message) []provider.DecisionTurn {
	calls := map[string]schema.ToolCall{}
	turns := []provider.DecisionTurn{}
	for _, msg := range messages {
		if msg.Role == schema.Assistant {
			for _, call := range msg.ToolCalls {
				calls[call.ID] = call
			}
		} else if msg.Role == schema.Tool {
			if call, ok := calls[msg.ToolCallID]; ok {
				turns = append(turns, provider.DecisionTurn{Name: call.Function.Name, Arguments: call.Function.Arguments, Output: msg.Content})
				delete(calls, msg.ToolCallID)
			}
		}
	}
	return turns
}

var transientProviderStatus = regexp.MustCompile(`provider HTTP (429|5\d\d):`)

func transientAgentProviderError(err error) bool {
	if err == nil || errors.Is(err, context.Canceled) {
		return false
	}
	var network net.Error
	var status *provider.StatusError
	if errors.As(err, &status) {
		return status.Status == 429 || status.Status >= 500 && status.Status <= 599
	}
	var empty *provider.EmptyResultError
	if errors.As(err, &empty) {
		return true
	}
	return errors.Is(err, context.DeadlineExceeded) || errors.As(err, &network) || transientProviderStatus.MatchString(err.Error()) || strings.Contains(err.Error(), "AI stream ended before completion")
}

func automationHarnessFailure(err error) error {
	var browser *BrowserError
	if errors.As(err, &browser) {
		return browser
	}
	if errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &planningFailure{err, "The AI provider did not finish the next live decision within 2 minutes. Completed actions remain recorded and were not replayed. You can inspect this run or start a new request."}
	}
	// Eino wraps component failures with internal graph paths. Keep those out
	// of user-facing errors while preserving the actual underlying failure.
	for depth := 0; depth < 12; depth++ {
		next := errors.Unwrap(err)
		if next == nil {
			break
		}
		err = next
	}
	return err
}
