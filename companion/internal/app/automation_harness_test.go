package app

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"voiceqa/companion/internal/provider"
)

func TestPaidFallbackOnlyForAvailabilityFailures(t *testing.T) {
	for _, test := range []struct {
		err      error
		fallback bool
	}{
		{errors.New("provider HTTP 502: unavailable"), true},
		{&provider.StatusError{Status: 502, Message: "OpenRouter HTTP 502: unavailable"}, true},
		{&provider.StatusError{Status: 429, Message: "rate limited"}, true},
		{&provider.StatusError{Status: 401, Message: "unauthorized"}, false},
		{&provider.StatusError{Status: 402, Message: "insufficient balance"}, false},
		{&provider.StatusError{Status: 0, Message: "unknown provider error"}, false},
		{&provider.EmptyResultError{}, true},
		{errors.New("provider HTTP 429: rate limited"), true},
		{context.DeadlineExceeded, true},
		{context.Canceled, false},
		{errors.New("provider HTTP 401: incorrect key"), false},
		{errors.New("provider HTTP 403: forbidden"), false},
		{errors.New("unsupported tool or declined permission"), false},
		{nil, false},
	} {
		if got := transientAgentProviderError(test.err); got != test.fallback {
			t.Fatal(test.err, got)
		}
	}
}

func TestHarnessTimeoutMessageRetainsCauseWithoutInternalGraphPaths(t *testing.T) {
	err := automationHarnessFailure(fmt.Errorf("[NodeRunError] graph detail: %w", context.DeadlineExceeded))
	if !errors.Is(err, context.DeadlineExceeded) || strings.Contains(err.Error(), "NodeRunError") || !strings.Contains(err.Error(), "2 minutes") {
		t.Fatal(err)
	}
	browser := &BrowserError{Code: "needs_review", Message: "Submission outcome is unknown"}
	if got := automationHarnessFailure(fmt.Errorf("[NodeRunError] %w", browser)); got != browser {
		t.Fatal("lost ambiguity classification", got)
	}
}
