package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"
)

type routerModel struct {
	ID         string   `json:"id"`
	Parameters []string `json:"supported_parameters"`
	Top        struct {
		MaxCompletion int `json:"max_completion_tokens"`
	} `json:"top_provider"`
	Reasoning struct {
		MaxTokens bool `json:"supports_max_tokens"`
	} `json:"reasoning"`
	Architecture struct {
		Output []string `json:"output_modalities"`
	} `json:"architecture"`
}
type modelCache struct {
	mu      sync.Mutex
	baseURL string
	expires time.Time
	entries map[string]routerModel
}

func (m routerModel) supports(parameter string) bool {
	for _, p := range m.Parameters {
		if p == parameter {
			return true
		}
	}
	return false
}
func (m routerModel) outputMode() string {
	if m.supports("response_format") && m.supports("structured_outputs") {
		return "json-schema"
	}
	if m.supports("response_format") {
		return "json-object"
	}
	return "prompt-json"
}
func (c *Client) routerModel(ctx context.Context, model string) (routerModel, error) {
	if cache := c.models; cache != nil {
		cache.mu.Lock()
		entry, found := cache.entries[model]
		fresh := cache.baseURL == c.BaseURL && time.Now().Before(cache.expires)
		cache.mu.Unlock()
		if fresh {
			if found {
				return entry, nil
			}
			return routerModel{}, fmt.Errorf("OpenRouter does not list model %q. Check the model ID in the composer", model)
		}
	}
	// This public catalog request carries no API key, prompt or website content.
	lookup, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, e := http.NewRequestWithContext(lookup, "GET", c.BaseURL+"/models", nil)
	if e != nil {
		return routerModel{}, e
	}
	client := c.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	res, e := client.Do(req)
	if e != nil {
		if ctx.Err() == nil && errors.Is(e, context.DeadlineExceeded) {
			return routerModel{}, errors.New("OpenRouter model-capability lookup timed out. No model request was sent; try again")
		}
		return routerModel{}, fmt.Errorf("OpenRouter model-capability lookup failed: %w", e)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return routerModel{}, fmt.Errorf("OpenRouter model catalog returned HTTP %d. Try again before planning", res.StatusCode)
	}
	raw, e := readPlanBody(res.Body)
	if e != nil {
		if ctx.Err() == nil && errors.Is(e, context.DeadlineExceeded) {
			return routerModel{}, errors.New("OpenRouter model-capability lookup timed out. No model request was sent; try again")
		}
		return routerModel{}, e
	}
	var catalog struct {
		Data []routerModel `json:"data"`
	}
	if json.Unmarshal(raw, &catalog) != nil || len(catalog.Data) == 0 || len(catalog.Data) > 10000 {
		return routerModel{}, errors.New("OpenRouter returned an invalid model catalog")
	}
	entries := make(map[string]routerModel, len(catalog.Data))
	for _, entry := range catalog.Data {
		if entry.ID != "" {
			entries[entry.ID] = entry
		}
	}
	if cache := c.models; cache != nil {
		cache.mu.Lock()
		cache.entries = entries
		cache.baseURL = c.BaseURL
		cache.expires = time.Now().Add(5 * time.Minute)
		cache.mu.Unlock()
	}
	entry, found := entries[model]
	if !found {
		return routerModel{}, fmt.Errorf("OpenRouter does not list model %q. Check the model ID in the composer", model)
	}
	return entry, nil
}
