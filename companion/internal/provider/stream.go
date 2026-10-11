package provider

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const PlanningTimeout = 6 * time.Minute
const planningOutputBudget = 16000
const routerPlanningBudget = 32768

type PlanProgress struct {
	Phase         string
	ReceivedChars int
}

// Planning has its own bounded deadline. Speech and target grounding retain the
// shorter default HTTP timeout. Only a completed response can become a plan.
func (c *Client) PlanStructured(ctx context.Context, key, model, instructions string, input, schema any, progress func(PlanProgress)) (json.RawMessage, map[string]int, error) {
	ctx, cancel := context.WithTimeout(ctx, PlanningTimeout)
	defer cancel()
	if c.Router {
		return c.chatStructured(ctx, key, model, instructions, input, schema, routerPlanningBudget, true, progress)
	}
	if c.NIM {
		return c.chatStructured(ctx, key, model, instructions, input, schema, planningOutputBudget, true, progress)
	}
	if e := c.checkKey(key); e != nil {
		return nil, nil, e
	}
	inputJSON, e := json.Marshal(input)
	if e != nil {
		return nil, nil, e
	}
	body := map[string]any{"model": model, "instructions": instructions, "input": string(inputJSON), "max_output_tokens": planningOutputBudget, "stream": true, "text": map[string]any{"format": map[string]any{"type": "json_schema", "name": "qa_result", "strict": true, "schema": schema}}}
	encoded, e := json.Marshal(body)
	if e != nil {
		return nil, nil, e
	}
	req, e := http.NewRequestWithContext(ctx, "POST", c.BaseURL+"/responses", bytes.NewReader(encoded))
	if e != nil {
		return nil, nil, e
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream, application/json")
	base := c.HTTP
	if base == nil {
		base = http.DefaultClient
	}
	client := *base
	client.Timeout = 0
	res, e := client.Do(req)
	if e != nil {
		return nil, nil, e
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		data, e := readPlanBody(res.Body)
		if e != nil {
			return nil, nil, e
		}
		var api struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(data, &api)
		message := strings.ReplaceAll(api.Error.Message, key, "[redacted]")
		if len(message) > 400 {
			message = message[:400]
		}
		return nil, nil, fmt.Errorf("provider HTTP %d: %s", res.StatusCode, message)
	}
	if strings.Contains(strings.ToLower(res.Header.Get("Content-Type")), "text/event-stream") {
		data, e := readPlanStream(res.Body, progress)
		if e != nil {
			return nil, nil, e
		}
		return parseStructured(data, planningOutputBudget)
	}
	// Some compatible services return completed JSON even for stream=true.
	data, e := readPlanBody(res.Body)
	if e != nil {
		return nil, nil, e
	}
	return parseStructured(data, planningOutputBudget)
}
func readPlanBody(body io.Reader) ([]byte, error) {
	const limit = 4 * 1024 * 1024
	data, e := io.ReadAll(io.LimitReader(body, limit+1))
	if e != nil {
		return nil, e
	}
	if len(data) > limit {
		return nil, errors.New("AI response exceeds the 4 MiB limit")
	}
	return data, nil
}
func readPlanStream(body io.Reader, progress func(PlanProgress)) ([]byte, error) {
	received := 0
	lastPhase := ""
	lastNotice := time.Time{}
	notify := func(phase string) {
		if progress != nil && (phase != lastPhase || time.Since(lastNotice) >= time.Second) {
			progress(PlanProgress{Phase: phase, ReceivedChars: received})
			lastPhase = phase
			lastNotice = time.Now()
		}
	}
	dispatch := func(eventName, raw string) ([]byte, error) {
		if raw == "[DONE]" {
			return nil, errors.New("AI stream ended without a completed response; no tests were run")
		}
		var event struct {
			Type     string          `json:"type"`
			Delta    string          `json:"delta"`
			Response json.RawMessage `json:"response"`
		}
		if json.Unmarshal([]byte(raw), &event) != nil {
			return nil, errors.New("AI stream contained an invalid event")
		}
		if eventName != "" && eventName != event.Type {
			return nil, errors.New("AI stream event type mismatch")
		}
		switch event.Type {
		case "response.created", "response.queued", "response.in_progress":
			notify("analyzing")
		case "response.output_text.delta":
			received += len(event.Delta)
			notify("generating")
		case "response.completed", "response.incomplete":
			if len(event.Response) == 0 {
				return nil, errors.New("AI stream omitted its terminal response")
			}
			var terminal struct {
				Status string `json:"status"`
			}
			if json.Unmarshal(event.Response, &terminal) != nil || "response."+terminal.Status != event.Type {
				return nil, errors.New("AI stream terminal status mismatch")
			}
			return event.Response, nil
		case "response.failed", "error":
			return nil, errors.New("AI provider stopped planning; no tests were run. Check model availability and try again")
		}
		return nil, nil
	}
	return readSSE(body, dispatch)
}

// Common bounded SSE framing; provider adapters decide what counts as completion.
func readSSE(body io.Reader, handle func(string, string) ([]byte, error)) ([]byte, error) {
	const limit = 8 * 1024 * 1024
	bounded := &io.LimitedReader{R: body, N: limit + 1}
	scanner := bufio.NewScanner(bounded)
	scanner.Buffer(make([]byte, 8192), 4*1024*1024)
	var data strings.Builder
	eventName := ""
	dispatch := func() ([]byte, error) {
		if data.Len() == 0 {
			return nil, nil
		}
		raw := strings.TrimSpace(data.String())
		data.Reset()
		return handle(eventName, raw)
	}
	for scanner.Scan() {
		if bounded.N <= 0 {
			return nil, errors.New("AI stream exceeds the 8 MiB limit")
		}
		line := scanner.Text()
		if line == "" {
			terminal, e := dispatch()
			if e != nil || terminal != nil {
				return terminal, e
			}
			eventName = ""
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		if strings.HasPrefix(line, "event:") {
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			continue
		}
		if strings.HasPrefix(line, "data:") {
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			if data.Len() > 4*1024*1024 {
				return nil, errors.New("AI stream event exceeds the 4 MiB limit")
			}
		}
	}
	if e := scanner.Err(); e != nil {
		return nil, e
	}
	if bounded.N <= 0 {
		return nil, errors.New("AI stream exceeds the 8 MiB limit")
	}
	terminal, e := dispatch()
	if e != nil || terminal != nil {
		return terminal, e
	}
	return nil, errors.New("AI stream ended before completion; no tests were run")
}
