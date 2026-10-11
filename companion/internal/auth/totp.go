package auth

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"hash"
	"strings"
	"time"
)

func DecodeSeed(seed string) ([]byte, error) {
	seed = strings.ToUpper(strings.Join(strings.Fields(seed), ""))
	seed = strings.TrimRight(seed, "=")
	b, e := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(seed)
	if e != nil || len(b) < 10 || len(b) > 128 {
		return nil, errors.New("TOTP seed must be valid Base32 containing 10–128 bytes")
	}
	return b, nil
}

// RFC 6238, implemented with standard-library HMAC and dynamic truncation.
func TOTP(seed, algorithm string, digits, period int, now time.Time) (string, error) {
	key, e := DecodeSeed(seed)
	if e != nil {
		return "", e
	}
	if (digits != 6 && digits != 8) || period < 15 || period > 120 || now.Unix() < 0 {
		return "", errors.New("invalid TOTP parameters")
	}
	var hasher func() hash.Hash
	switch algorithm {
	case "sha1":
		hasher = sha1.New
	case "sha256":
		hasher = sha256.New
	case "sha512":
		hasher = sha512.New
	default:
		return "", errors.New("TOTP algorithm must be sha1, sha256 or sha512")
	}
	counter := make([]byte, 8)
	binary.BigEndian.PutUint64(counter, uint64(now.Unix()/int64(period)))
	mac := hmac.New(hasher, key)
	_, _ = mac.Write(counter)
	digest := mac.Sum(nil)
	offset := digest[len(digest)-1] & 15
	value := binary.BigEndian.Uint32(digest[offset:offset+4]) & 0x7fffffff
	modulus := uint32(1000000)
	if digits == 8 {
		modulus = 100000000
	}
	return fmt.Sprintf("%0*d", digits, value%modulus), nil
}
