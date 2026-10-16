package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode"
	"voiceqa/companion/internal/core"
	"voiceqa/companion/internal/visualagent"
)

var shortVisualCaption = regexp.MustCompile(`^[\p{L} ]{2,32}$`)

// A grounded coordinate is not permission to click a contradictory labelled
// button. Dynamic/account captions and unlabelled custom controls retain their
// normal DOM/visual validation; this check grants no additional capability.
func validateVisualCaption(description string, meta map[string]any) error {
	caption := strings.Join(strings.Fields(strings.ToLower(stringField(meta, "name"))), " ")
	if stringField(meta, "tag") != "BUTTON" || !shortVisualCaption.MatchString(caption) {
		return nil
	}
	intent := strings.Join(strings.FieldsFunc(strings.ToLower(description), func(r rune) bool { return !unicode.IsLetter(r) }), " ")
	if !strings.Contains(" "+intent+" ", " "+caption+" ") {
		return fmt.Errorf("Visual target label %q contradicts the proposed control description. No input was dispatched. Re-inspect the intended control and quote its exact visible button text", caption)
	}
	return nil
}

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
	acceptance := os.Getenv("VOICEQA_ACCEPTANCE_MODEL") == visualagent.AcceptanceModel && model == visualagent.AcceptanceModel
	return providerName == "openrouter" && (model == dotsModel || model == fallbackModel || acceptance) && a.keyFor("openrouter") != "" && visualagent.Available()
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
func (a *App) resolveVisualAction(ctx context.Context, r *core.Run, action core.Action, point *core.VisualPoint, description string) (core.Action, error) {
	if action.Operation != "click" && action.Operation != "fill" && action.Operation != "key" {
		return action, errors.New("Visual intent is not an allowed browser action")
	}
	meta, err := a.browser(ctx, r.ID, "", map[string]any{"operation": "visual_resolve", "origin": r.Plan.Origin, "visual": point, "actionOperation": action.Operation})
	if err != nil {
		return action, err
	}
	if action.Operation == "click" && description != "" {
		if err = validateVisualCaption(description, meta); err != nil {
			return action, err
		}
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
	result, err := a.resolveVisualAction(ctx, r, action, visualPoint(reply, image), "")
	if err == nil {
		r.AgentEvents = append(r.AgentEvents, map[string]any{"kind": "agent_route", "name": "agent-s3", "model": reply.Model, "artifactId": image["artifactId"], "reason": "Reviewed QA target missing before dispatch", "at": core.Now()})
	}
	return result, err
}
func (s *automationSession) visualDecision(ctx context.Context, reason string) (string, error) {
	r := s.run
	s.event("agent_route", "agent-s3")
	if len(r.AgentEvents) > 0 {
		e := r.AgentEvents[len(r.AgentEvents)-1]
		e["model"], e["reason"] = visualagent.ModelName(), reason
	}
	r.AgentModel, r.AgentPhase = visualagent.ModelName(), "Agent S: inspecting current browser screenshot"
	s.app.update(r)
	history := []map[string]any{}
	for _, step := range r.Steps[max(0, len(r.Steps)-8):] {
		history = append(history, map[string]any{"operation": step.Action.Operation, "target": step.Action.Target, "label": recordedText(step.Action.Label, 180), "resolvedControl": step.Result["resolvedControl"], "status": step.Status, "error": recordedText(step.Error, 250), "publicValueExcerpt": recordedText(step.Action.Value, 250)})
	}
	last := s.visualReply.Result
	last.Value = recordedText(last.Value, 250)
	progress := []map[string]any{}
	for _, checkpoint := range r.GoalProgress {
		progress = append(progress, map[string]any{"kind": checkpoint["kind"], "label": checkpoint["label"], "target": checkpoint["target"], "stepId": checkpoint["stepId"], "contentHash": checkpoint["contentHash"], "editorURI": checkpoint["editorURI"]})
	}
	input, _ := json.Marshal(map[string]any{"goal": r.Plan.Request, "verifiedProgress": progress, "permissions": r.Plan.Automation, "scope": s.scope, "publicValues": r.Values, "recentSteps": history, "lastVisualIntent": last, "lastValidation": s.validation, "controller": "DOM targeting has stalled. Preserve verified work and continue the UNFINISHED part of the goal using visible controls, including deployed function calls when testing remains. Do not rewrite a verified source or repeat deployment without actual contradictory evidence. Choose one grounded click/fill/press. A report, inspect or done does not test a contract or prove completion. Repeat only an identified non-submitting UI opener when its earlier click had no effect; never replay uncertain/consequential submissions. Inspect the screenshot and do not assume a dialog opened. A done handoff is independently checked; do not use it repeatedly to avoid unfinished interaction."})
	reply, image, err := s.visual.call(ctx, s.app, r.ID, r.Plan.Origin, string(input), "", false, r.Usage)
	if err != nil {
		return "", err
	}
	s.visualReply, s.visualImage = reply, image
	s.visualTicket = core.ID()
	return s.visualTicket, nil
}
