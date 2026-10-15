package provider

import (
	"errors"
	"fmt"
)

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
