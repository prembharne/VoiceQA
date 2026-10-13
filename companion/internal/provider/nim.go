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

// Hosted NVIDIA NIM and OpenRouter use Chat Completions. OpenRouter's
// schema/JSON/text mode is selected from its advertised model capabilities.
// A stop finish_reason AND [DONE] are required for a streamed draft.
func (c *Client) chatStructured(ctx context.Context, key, model, instructions string, input, schema any, budget int, stream bool, progress func(PlanProgress)) (json.RawMessage, map[string]int, error) {
	if e := c.checkKey(key); e != nil {
		return nil, nil, e
	}
	inputJSON, e := json.Marshal(input)
	if e != nil {
		return nil, nil, e
	}
	mode := "json-schema"
	name := "NVIDIA NIM"
	var capabilities routerModel
	if c.Router {
		name = "OpenRouter"
		capabilities, e = c.routerModel(ctx, model)
		if e != nil {
			return nil, nil, e
		}
		textOutput := false
		for _, kind := range capabilities.Architecture.Output {
			if kind == "text" {
				textOutput = true
			}
		}
		if !textOutput {
			return nil, nil, errors.New("Choose an OpenRouter model that can generate text plans")
		}
		mode = capabilities.outputMode()
		if budget > 0 && capabilities.Top.MaxCompletion > 0 && capabilities.Top.MaxCompletion < budget {
			budget = capabilities.Top.MaxCompletion
		}
		if (budget > 0 && budget < 512) || (budget == 0 && capabilities.Top.MaxCompletion > 0 && capabilities.Top.MaxCompletion < 512) {
			return nil, nil, errors.New("The selected model's output budget is too small for a test plan")
		}
		if progress != nil && mode != "json-schema" {
			progress(PlanProgress{Phase: "adapting"})
		}
	}
	// Some compatible endpoints advertise strict output but do not expose the
	// format contract to the model. Put the schema in the prompt as well; local
	// validation remains authoritative even with native structured output.
	{
		schemaJSON, err := json.Marshal(schema)
		if err != nil {
			return nil, nil, err
		}
		instructions += "\nFollow this complete JSON schema exactly. Return one JSON object only, without Markdown fences or commentary: " + string(schemaJSON)
	}
	body := map[string]any{
		"model": model, "stream": stream,
		"messages": []map[string]string{{"role": "system", "content": instructions + "\nReturn only JSON matching the supplied response schema."}, {"role": "user", "content": string(inputJSON)}},
	}
	if budget > 0 {
		body["max_tokens"] = budget
	}
	switch mode {
	case "json-schema":
		body["response_format"] = map[string]any{"type": "json_schema", "json_schema": map[string]any{"name": "qa_result", "strict": true, "schema": schema}}
	case "json-object":
		body["response_format"] = map[string]any{"type": "json_object"}
	}
	if c.Router {
		body["provider"] = map[string]any{"require_parameters": true}
		reasoningAllowance := budget
		if reasoningAllowance == 0 {
			reasoningAllowance = capabilities.Top.MaxCompletion
		}
		if stream && capabilities.supports("reasoning") && capabilities.Reasoning.MaxTokens && (reasoningAllowance == 0 || reasoningAllowance >= 2048) {
			cap := 4096
			if reasoningAllowance > 0 {
				cap = max(1024, min(4096, reasoningAllowance/4))
			}
			body["reasoning"] = map[string]any{"max_tokens": cap}
		}
	}
	if stream && c.NIM {
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
		// OpenRouter places upstream details inside error.metadata.
		var nested struct {
			Error struct {
				Metadata struct {
					Raw string `json:"raw"`
				} `json:"metadata"`
			} `json:"error"`
		}
		_ = json.Unmarshal(raw, &nested)
		msg := api.Error.Message
		if msg == "" {
			msg = api.Detail
		}
		if vendor := nested.Error.Metadata.Raw; vendor != "" && len(vendor) < 8192 {
			var details struct {
				Error struct {
					Message string `json:"message"`
				} `json:"error"`
				Message string `json:"message"`
				Detail  string `json:"detail"`
			}
			if json.Unmarshal([]byte(vendor), &details) == nil {
				message := details.Error.Message
				if message == "" {
					message = details.Message
				}
				if message == "" {
					message = details.Detail
				}
				if message != "" {
					msg += ": " + message
				}
			}
		}
		msg = strings.ReplaceAll(msg, key, "[redacted]")
		if len(msg) > 400 {
			msg = msg[:400]
		}
		if msg == "" {
			msg = "Request rejected. Check the key, model access and account quota."
		}
		if c.Router && res.StatusCode == 404 {
			return nil, nil, fmt.Errorf("OpenRouter has no available endpoint for model %q with %s output. Check provider availability and your account routing preferences; no model was switched. Details: %s", model, mode, msg)
		}
		return nil, nil, fmt.Errorf("%s HTTP %d: %s", name, res.StatusCode, msg)
	}
	var raw []byte
	if strings.Contains(strings.ToLower(res.Header.Get("Content-Type")), "text/event-stream") {
		raw, e = readChatStream(res.Body, progress)
	} else {
		raw, e = readPlanBody(res.Body)
	}
	if e != nil {
		var limit *chatLimitError
		if errors.As(e, &limit) {
			return nil, nil, generationLimitMessage(budget)
		}
		return nil, nil, e
	}
	return parseChatStructuredMode(raw, budget, c.Router && mode != "json-schema")
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
	return parseChatStructuredMode(raw, budget, false)
}
func parseChatStructuredMode(raw []byte, budget int, allowFence bool) (json.RawMessage, map[string]int, error) {
	var response chatCompletion
	if e := json.Unmarshal(raw, &response); e != nil {
		return nil, nil, e
	}
	usage := map[string]int{"input_tokens": response.Usage.Input, "output_tokens": response.Usage.Output, "total_tokens": response.Usage.Total}
	if len(response.Choices) != 1 || response.Choices[0].Index != 0 {
		return nil, usage, errors.New("AI provider omitted its completed answer")
	}
	choice := response.Choices[0]
	if choice.Finish == "length" {
		return nil, usage, generationLimitMessage(budget)
	}
	if choice.Finish != "stop" || choice.Message.Refusal != "" || len(response.Error) > 0 && string(response.Error) != "null" {
		return nil, usage, errors.New("AI response incomplete or refused; no tests were run")
	}
	if allowFence {
		text := strings.TrimSpace(choice.Message.Content)
		for _, prefix := range []string{"```json\n", "```\n"} {
			if strings.HasPrefix(text, prefix) && strings.HasSuffix(text, "\n```") {
				choice.Message.Content = strings.TrimSuffix(strings.TrimPrefix(text, prefix), "\n```")
				break
			}
		}
	}
	if !json.Valid([]byte(choice.Message.Content)) {
		return nil, usage, errors.New("AI provider did not return valid JSON; no tests were run")
	}
	return json.RawMessage(choice.Message.Content), usage, nil
}

type chatLimitError struct{}

func generationLimitMessage(budget int) error {
	if budget > 0 {
		return fmt.Errorf("The provider reached this model's combined reasoning/answer allowance (%d tokens). No plan was saved", budget)
	}
	return errors.New("The provider reached this model's output allowance. VoiceQA did not impose an output-token cap. No plan was saved")
}

func (*chatLimitError) Error() string { return "AI generation reached its output limit" }
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
			return nil, errors.New("AI stream used an unexpected event type")
		}
		if raw == "[DONE]" {
			if !finished {
				return nil, errors.New("AI stream ended without a completed answer; no tests were run")
			}
			completion.Choices = []chatChoice{{Index: 0, Finish: "stop"}}
			completion.Choices[0].Message.Content = content.String()
			return json.Marshal(completion)
		}
		var chunk chatCompletion
		if e := json.Unmarshal([]byte(raw), &chunk); e != nil {
			return nil, errors.New("AI stream contained an invalid event")
		}
		if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
			return nil, streamProviderError(chunk.Error)
		}
		if chunk.Usage.Total > 0 {
			completion.Usage = chunk.Usage
		}
		for _, choice := range chunk.Choices {
			if choice.Index != 0 {
				return nil, errors.New("AI provider returned multiple answers")
			}
			if choice.Delta.Refusal != "" {
				return nil, errors.New("AI provider declined this request")
			}
			// OpenRouter may repeat an empty stop choice in its usage chunk.
			if finished && (choice.Delta.Content != "" || (choice.Finish != "" && choice.Finish != "stop")) {
				return nil, errors.New("AI stream continued after completion")
			}
			if choice.Delta.Content != "" {
				content.WriteString(choice.Delta.Content)
				if content.Len() > 4*1024*1024 {
					return nil, errors.New("AI answer exceeds the 4 MiB limit")
				}
				notify("generating")
			}
			if choice.Finish != "" {
				if choice.Finish == "length" {
					return nil, &chatLimitError{}
				}
				if choice.Finish != "stop" {
					return nil, errors.New("AI generation incomplete or refused; no tests were run")
				}
				finished = true
			}
		}
		return nil, nil
	})
}

// Surface numeric provider status without forwarding raw upstream text, which
// may contain request data or credentials. No partial plan is accepted.
func streamProviderError(raw json.RawMessage) error {
	var detail struct {
		Code int `json:"code"`
	}
	if json.Unmarshal(raw, &detail) == nil && detail.Code >= 400 && detail.Code <= 599 {
		return fmt.Errorf("AI provider returned a stream error (HTTP %d). No draft was accepted and no tests were run", detail.Code)
	}
	return errors.New("AI provider reported an error while streaming the plan. No draft was accepted and no tests were run")
}
