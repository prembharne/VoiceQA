package provider

import (
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

func (c *Client) ValidateKey(key string) error { return c.checkKey(key) }
func (c *Client) checkKey(key string) error {
	if key == "" {
		return errors.New("Configure an API key in Settings, or use the explicit fixture demo")
	}
	if strings.HasPrefix(key, "nvapi-") && !c.NIM {
		return errors.New("NVIDIA keys can only be used with the NVIDIA NIM provider")
	}
	if strings.HasPrefix(key, "sk-or-") && !c.Router {
		return errors.New("OpenRouter key cannot be sent to this provider. Select OpenRouter in Settings")
	}
	if c.NIM && strings.HasPrefix(key, "sk-") {
		return errors.New("NVIDIA NIM needs its own NVIDIA API key")
	}
	return nil
}

// Hosted NVIDIA NIM uses Chat Completions, not the Responses endpoint.
// A stop finish_reason AND [DONE] are required for a streamed draft.
func (c *Client) chatStructured(ctx context.Context, key, model, instructions string, input, schema any, budget int, stream bool, progress func(PlanProgress)) (json.RawMessage, map[string]int, error) {
	if e := c.checkKey(key); e != nil {
		return nil, nil, e
	}
	inputJSON, e := json.Marshal(input)
	if e != nil {
		return nil, nil, e
	}
	body := map[string]any{
		"model": model, "max_tokens": budget, "stream": stream,
		"messages":        []map[string]string{{"role": "system", "content": instructions + "\nReturn only JSON matching the supplied response schema."}, {"role": "user", "content": string(inputJSON)}},
		"response_format": map[string]any{"type": "json_schema", "json_schema": map[string]any{"name": "qa_result", "strict": true, "schema": schema}},
	}
	if stream {
		body["stream_options"] = map[string]any{"include_usage": true}
	}
	encoded, e := json.Marshal(body)
	if e != nil {
		return nil, nil, e
	}
	req, e := http.NewRequestWithContext(ctx, "POST", c.BaseURL+"/chat/completions", bytes.NewReader(encoded))
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
	if stream {
		client.Timeout = 0
	}
	res, e := client.Do(req)
	if e != nil {
		return nil, nil, e
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		raw, e := readPlanBody(res.Body)
		if e != nil {
			return nil, nil, e
		}
		var api struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
			Detail string `json:"detail"`
		}
		_ = json.Unmarshal(raw, &api)
		msg := api.Error.Message
		if msg == "" {
			msg = api.Detail
		}
		msg = strings.ReplaceAll(msg, key, "[redacted]")
		if len(msg) > 400 {
			msg = msg[:400]
		}
		if msg == "" {
			msg = "NVIDIA request rejected. Check the key, model access and account quota."
		}
		return nil, nil, fmt.Errorf("NVIDIA HTTP %d: %s", res.StatusCode, msg)
	}
	var raw []byte
	if strings.Contains(strings.ToLower(res.Header.Get("Content-Type")), "text/event-stream") {
		raw, e = readChatStream(res.Body, progress)
	} else {
		raw, e = readPlanBody(res.Body)
	}
	if e != nil {
		return nil, nil, e
	}
	return parseChatStructured(raw, budget)
}

type chatChoice struct {
	Index   int    `json:"index"`
	Finish  string `json:"finish_reason"`
	Message struct {
		Content string `json:"content"`
		Refusal string `json:"refusal"`
	} `json:"message"`
	Delta struct {
		Content string `json:"content"`
		Refusal string `json:"refusal"`
	} `json:"delta"`
}
type chatCompletion struct {
	Choices []chatChoice `json:"choices"`
	Usage   struct {
		Input  int `json:"prompt_tokens"`
		Output int `json:"completion_tokens"`
		Total  int `json:"total_tokens"`
	} `json:"usage"`
	Error json.RawMessage `json:"error"`
}

func parseChatStructured(raw []byte, budget int) (json.RawMessage, map[string]int, error) {
	var response chatCompletion
	if e := json.Unmarshal(raw, &response); e != nil {
		return nil, nil, e
	}
	usage := map[string]int{"input_tokens": response.Usage.Input, "output_tokens": response.Usage.Output, "total_tokens": response.Usage.Total}
	if len(response.Choices) != 1 || response.Choices[0].Index != 0 {
		return nil, usage, errors.New("NVIDIA omitted its completed answer")
	}
	choice := response.Choices[0]
	if choice.Finish == "length" {
		return nil, usage, fmt.Errorf("NVIDIA output limit reached (%d tokens). No tests were run", budget)
	}
	if choice.Finish != "stop" || choice.Message.Refusal != "" || len(response.Error) > 0 && string(response.Error) != "null" {
		return nil, usage, errors.New("NVIDIA response incomplete or refused; no tests were run")
	}
	if !json.Valid([]byte(choice.Message.Content)) {
		return nil, usage, errors.New("NVIDIA did not return valid structured JSON; no tests were run")
	}
	return json.RawMessage(choice.Message.Content), usage, nil
}

func readChatStream(body io.Reader, progress func(PlanProgress)) ([]byte, error) {
	var content strings.Builder
	var completion chatCompletion
	finished := false
	lastNotice := time.Time{}
	lastPhase := ""
	notify := func(phase string) {
		if progress != nil && (phase != lastPhase || time.Since(lastNotice) >= time.Second) {
			progress(PlanProgress{phase, content.Len()})
			lastNotice = time.Now()
			lastPhase = phase
		}
	}
	notify("analyzing")
	return readSSE(body, func(name, raw string) ([]byte, error) {
		if name != "" && name != "message" {
			return nil, errors.New("NVIDIA stream used an unexpected event type")
		}
		if raw == "[DONE]" {
			if !finished {
				return nil, errors.New("NVIDIA stream ended without a completed answer; no tests were run")
			}
			completion.Choices = []chatChoice{{Index: 0, Finish: "stop"}}
			completion.Choices[0].Message.Content = content.String()
			return json.Marshal(completion)
		}
		var chunk chatCompletion
		if e := json.Unmarshal([]byte(raw), &chunk); e != nil {
			return nil, errors.New("NVIDIA stream contained an invalid event")
		}
		if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
			return nil, errors.New("NVIDIA stopped planning; no tests were run")
		}
		if chunk.Usage.Total > 0 {
			completion.Usage = chunk.Usage
		}
		for _, choice := range chunk.Choices {
			if choice.Index != 0 {
				return nil, errors.New("NVIDIA returned multiple answers")
			}
			if choice.Delta.Refusal != "" {
				return nil, errors.New("NVIDIA declined this request")
			}
			if finished && (choice.Delta.Content != "" || choice.Finish != "") {
				return nil, errors.New("NVIDIA stream continued after completion")
			}
			if choice.Delta.Content != "" {
				content.WriteString(choice.Delta.Content)
				if content.Len() > 4*1024*1024 {
					return nil, errors.New("NVIDIA answer exceeds the 4 MiB limit")
				}
				notify("generating")
			}
			if choice.Finish != "" {
				if choice.Finish != "stop" {
					return nil, errors.New("NVIDIA generation incomplete or refused; no tests were run")
				}
				finished = true
			}
		}
		return nil, nil
	})
}
