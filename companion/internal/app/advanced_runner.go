package app

import (
	"context"
	"errors"
	"time"
	"voiceqa/companion/internal/core"
)

func canReground(operation string) bool {
	switch operation {
	case "click", "fill", "select":
		return true
	default:
		return false
	}
}

func (a *App) executeAdvanced(ctx context.Context, r *core.Run, idx int, action core.Action) (map[string]any, error) {
	payload := map[string]any{"operation": "execute", "action": action, "origin": r.Plan.Origin, "mode": r.Plan.Mode}
	if action.Visual != nil {
		payload["operation"], payload["visual"] = "execute_visual", action.Visual
	}
	secure := action.Operation == "fill_secret" || action.Operation == "fill_totp"
	if secure {
		location, e := a.browser(ctx, r.ID, "", map[string]any{"operation": "location", "origin": r.Plan.Origin})
		if e != nil {
			return nil, e
		}
		origin, _ := location["origin"].(string)
		copy, e := a.secureAction(ctx, action, origin)
		if e != nil {
			return nil, e
		}
		payload["action"] = copy
		payload["secure"] = true
		payload["secureOrigin"] = origin
	}
	result, e := a.browser(ctx, r.ID, r.Steps[idx].ID, payload)
	if secure && e != nil {
		if errors.Is(e, context.Canceled) || errors.Is(e, context.DeadlineExceeded) {
			return nil, e
		}
		var browser *BrowserError
		if errors.As(e, &browser) {
			return nil, &BrowserError{Code: browser.Code, Message: "Secure entry failed; credential value was redacted."}
		}
		return nil, errors.New("secure entry failed; credential value was redacted")
	}
	if e != nil {
		return result, e
	}
	if action.Operation != "human_checkpoint" {
		return result, nil
	}
	gate, ok := result["handoff"].(map[string]any)
	if !ok {
		return nil, errors.New("browser did not create a human checkpoint")
	}
	id, _ := gate["id"].(string)
	page, _ := gate["page"].(string)
	if id == "" {
		return nil, errors.New("checkpoint has no identity")
	}
	r.Handoff = &core.Handoff{ID: id, Kind: action.Value, Label: action.Label, Page: page}
	a.update(r)
	defer func() { r.Handoff = nil }()
	timer := time.NewTicker(500 * time.Millisecond)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
		}
		response, err := a.browser(ctx, r.ID, "", map[string]any{"operation": "handoff.poll", "id": id, "origin": r.Plan.Origin})
		if err != nil {
			return nil, err
		}
		if response["completed"] == true {
			return map[string]any{"manualCompletion": true, "kind": action.Value, "page": page}, nil
		}
	}
}
