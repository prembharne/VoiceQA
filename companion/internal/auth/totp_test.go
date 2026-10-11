package auth

import (
	"encoding/base32"
	"testing"
	"time"
)

func TestRFC6238Vectors(t *testing.T) {
	times := []int64{59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000}
	fixtures := []struct {
		algorithm, secret string
		codes             []string
	}{
		{"sha1", "12345678901234567890", []string{"94287082", "07081804", "14050471", "89005924", "69279037", "65353130"}},
		{"sha256", "12345678901234567890123456789012", []string{"46119246", "68084774", "67062674", "91819424", "90698825", "77737706"}},
		{"sha512", "1234567890123456789012345678901234567890123456789012345678901234", []string{"90693936", "25091201", "99943326", "93441116", "38618901", "47863826"}},
	}
	for _, f := range fixtures {
		for i, ts := range times {
			seed := base32.StdEncoding.EncodeToString([]byte(f.secret))
			code, e := TOTP(seed, f.algorithm, 8, 30, time.Unix(ts, 0))
			if e != nil || code != f.codes[i] {
				t.Fatalf("%s at %d: %s, %v", f.algorithm, ts, code, e)
			}
		}
	}
}
func TestRejectInvalidTOTPConfiguration(t *testing.T) {
	for _, seed := range []string{"abc", "not-a-seed", ""} {
		if _, e := TOTP(seed, "sha1", 6, 30, time.Now()); e == nil {
			t.Fatal("invalid seed accepted")
		}
	}
}
