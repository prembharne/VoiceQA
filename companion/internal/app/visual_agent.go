package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/visualagent"
)

type visualSession struct {
	worker *visualagent.Client
	usage  map[string]int
}

func (s *visualSession) close() {
	if s.worker != nil {
		s.worker.Close()
		s.worker = nil
	}
	s.usage = nil
}
func (a *App) visualAvailable(providerName, model string) bool {
	return providerName == "openrouter" && (model == dotsModel || model == fallbackModel) && a.keyFor("openrouter") != "" && visualagent.Available()
}
func (s *visualSession) call(ctx context.Context, a *App, runID, origin, instruction, description string, readOnly bool, usage map[string]int) (visualagent.Reply, map[string]any, error) {
	var reply visualagent.Reply
	settings := a.getSettings()
	image, err := a.browser(ctx, runID, "", map[string]any{"operation": "visual_capture", "origin": origin, "maskSelectors": settings.MaskSelectors, "visualMaskSelectors": settings.VisualMaskSelectors})
	// A fresh screenshot is a read, so settling/capture races can be retried
	// before spending any model call or dispatching input.
	for attempt := 0; err != nil && attempt < 2; attempt++ {
		var stale *BrowserError
		if !errors.As(err, &stale) || stale.Code != "target_missing" {
			break
		}
		image, err = a.browser(ctx, runID, "", map[string]any{"operation": "visual_capture", "origin": origin, "maskSelectors": settings.MaskSelectors, "visualMaskSelectors": settings.VisualMaskSelectors})
	}
	if err != nil {
		return reply, nil, err
	}
	bytes, err := a.Store.ReadArtifact(fmt.Sprint(image["artifactId"]))
	if err != nil {
		return reply, nil, err
	}
	if len(bytes) > 6*1024*1024 {
		return reply, nil, errors.New("Visual screenshot exceeds allowance")
	}
	if s.worker == nil {
		s.worker, err = visualagent.Start(ctx)
		if err != nil {
			return reply, nil, err
		}
	}
	payload := map[string]any{"key": a.keyFor("openrouter"), "readOnly": readOnly, "image": base64.StdEncoding.EncodeToString(bytes), "instruction": instruction}
	if description != "" {
		payload["mode"], payload["description"] = "ground", description
	}
	callCtx, cancel := context.WithTimeout(ctx, 150*time.Second)
	defer cancel()
	reply, err = s.worker.Call(callCtx, payload)
	if s.usage == nil {
		s.usage = map[string]int{}
	}
	for key, n := range reply.Usage {
		if n >= s.usage[key] {
			usage[key] += n - s.usage[key]
		}
		s.usage[key] = n
	}
	return reply, image, err
}

func visualPoint(reply visualagent.Reply, image map[string]any) *core.VisualPoint {
	w, h := visualInt(image["width"]), visualInt(image["height"])
	x, y := reply.Result.X, reply.Result.Y
	if reply.Result.Width > 0 && reply.Result.Height > 0 {
		x = x * w / reply.Result.Width
		y = y * h / reply.Result.Height
	}
	return &core.VisualPoint{Snapshot: fmt.Sprint(image["snapshot"]), X: x, Y: y, Width: w, Height: h}
}
func visualInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	}
	return 0
}
func (a *App) resolveVisualAction(ctx context.Context, r *core.Run, action core.Action, point *core.VisualPoint) (core.Action, error) {
	if action.Operation != "click" && action.Operation != "fill" && action.Operation != "key" {
		return action, errors.New("Visual intent is not an allowed browser action")
	}
	meta, err := a.browser(ctx, r.ID, "", map[string]any{"operation": "visual_resolve", "origin": r.Plan.Origin, "visual": point, "actionOperation": action.Operation})
	if err != nil {
		return action, err
	}
	if action.Operation != "key" {
		action.Target, _ = meta["target"].(string)
		if action.Target == "" {
			return action, errors.New("Visual target did not resolve to a current control")
		}
		if err = validateResolvedAutomationControl(action, meta); err != nil {
			return action, err
		}
	}
	action.Visual = point
	return action, nil
}
func (a *App) groundVisual(ctx context.Context, r *core.Run, action core.Action) (core.Action, error) {
	s := &visualSession{}
	defer s.close()
	reply, image, err := s.call(ctx, a, r.ID, r.Plan.Origin, "", action.Label+". Original target: "+action.Target, true, r.Usage)
	if err != nil {
		return action, err
	}
	if reply.Result.Operation != "inspect" {
		return action, errors.New("Grounder returned an unexpected intent")
	}
	result, err := a.resolveVisualAction(ctx, r, action, visualPoint(reply, image))
	if err == nil {
		r.AgentEvents = append(r.AgentEvents, map[string]any{"kind": "agent_route", "name": "agent-s3", "model": visualagent.Model, "artifactId": image["artifactId"], "reason": "Reviewed QA target missing before dispatch", "at": core.Now()})
	}
	return result, err
}
func (s *automationSession) visualDecision(ctx context.Context, reason string) (string, error) {
	r := s.run
	s.event("agent_route", "agent-s3")
	if len(r.AgentEvents) > 0 {
		e := r.AgentEvents[len(r.AgentEvents)-1]
		e["model"], e["reason"] = visualagent.Model, reason
	}
	r.AgentModel, r.AgentPhase = visualagent.Model, "Agent S: inspecting current browser screenshot"
	s.app.update(r)
	history := []map[string]any{}
	for _, step := range r.Steps[max(0, len(r.Steps)-8):] {
		history = append(history, map[string]any{"operation": step.Action.Operation, "target": step.Action.Target, "label": recordedText(step.Action.Label, 180), "status": step.Status, "error": recordedText(step.Error, 250), "publicValueExcerpt": recordedText(step.Action.Value, 250)})
	}
	last := s.visualReply.Result
	last.Value = recordedText(last.Value, 250)
	input, _ := json.Marshal(map[string]any{"goal": r.Plan.Request, "permissions": r.Plan.Automation, "scope": s.scope, "publicValues": r.Values, "recentSteps": history, "lastVisualIntent": last, "lastValidation": s.validation, "controller": "DOM targeting has stalled. Continue the UNFINISHED part of the goal using the visible browser controls. Choose click/fill/press to advance it. A report or inspect does not execute a click. Do not repeat prior unchanged actions. Use done only when no requested visual action remains; the controller independently checks completion. Inspect the screenshot; do not assume a dialog opened."})
	reply, image, err := s.visual.call(ctx, s.app, r.ID, r.Plan.Origin, string(input), "", false, r.Usage)
	if err != nil {
		return "", err
	}
	s.visualReply, s.visualImage = reply, image
	s.visualTicket = core.ID()
	return s.visualTicket, nil
}
