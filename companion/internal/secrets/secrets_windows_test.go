//go:build windows

package secrets

import (
	"bytes"
	"testing"
)

func TestDPAPIRoundTrip(t *testing.T) {
	plain := []byte("fixture-secret")
	encrypted, e := Protect(plain)
	if e != nil {
		t.Fatal(e)
	}
	if bytes.Contains(encrypted, plain) {
		t.Fatal("plaintext remained in encrypted value")
	}
	decrypted, e := Unprotect(encrypted)
	if e != nil || !bytes.Equal(decrypted, plain) {
		t.Fatal("DPAPI round trip failed", e)
	}
}
