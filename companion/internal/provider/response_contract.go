package provider

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
)

// StatusError preserves a provider status independently of its display name.
// It also handles providers which send an error envelope with HTTP 200.
type StatusError struct {
	Status  int
	Message string
}

func (e *StatusError) Error() string { return e.Message }

// EmptyResultError means no decision was returned and nothing can be dispatched.
// It is different from an explicit refusal, malformed call or denied permission.
type EmptyResultError struct{}

func (*EmptyResultError) Error() string {
	return "The AI provider returned no completed result. No tool decision was executed from this reply"
}

func responseEnvelopeError(raw json.RawMessage) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var envelope struct {
		Code json.RawMessage `json:"code"`
	}
	_ = json.Unmarshal(raw, &envelope)
	var code int
	if json.Unmarshal(envelope.Code, &code) != nil {
		var text string
		_ = json.Unmarshal(envelope.Code, &text)
		code, _ = strconv.Atoi(text)
	}
	if code < 400 || code > 599 {
		code = 0
	}
	// Never echo a vendor's raw message: it can contain request values/secrets.
	return &StatusError{Status: code, Message: fmt.Sprintf("AI provider returned an error envelope (status=%d). No tool decision was executed from this reply", code)}
}

// ResponseContractError means a completed model reply was rejected before any
// operation was dispatched. A caller may request a bounded correction of that
// reply; it must never use this classification to replay an executed action.
type ResponseContractError struct{ message string }

func (e *ResponseContractError) Error() string { return e.message }

func responseContractErrorf(format string, args ...any) error {
	return &ResponseContractError{message: fmt.Sprintf(format, args...)}
}

func IsResponseContractError(err error) bool {
	var contract *ResponseContractError
	return errors.As(err, &contract)
}
