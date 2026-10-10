//go:build !windows

package secrets

import "errors"

func Protect(data []byte) ([]byte, error) {
	return nil, errors.New("saved API keys require Windows DPAPI; use OPENAI_API_KEY on this platform")
}
func Unprotect(data []byte) ([]byte, error) {
	return nil, errors.New("saved API keys require Windows DPAPI")
}
