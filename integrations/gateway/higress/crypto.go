package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
)

// The session map is the plaintext. It leaves this process only sealed.
//
// Cross-worker state is unavoidable — Envoy gives every worker thread its own
// Wasm VM, so a conversation's turns land in different VMs and an in-memory map
// re-masks nothing on turn 2. But the map IS the secrets and PII we were asked
// to remove, so putting it in a store as-is would make that store hold exactly
// what the whole design keeps out of storage (a verdict carries offsets and no
// matched text; `plaintext-containment.test.ts` pins six write sites in the
// runtime for this reason).
//
// So it is sealed with AES-256-GCM under a key that lives only in the plugin's
// configuration: Redis holds ciphertext, a dump of it is useless, and the
// gateway-side store never becomes a copy of the data it guards.
//
// ⚠️ The key is a REAL key. Rotating it invalidates every live session (their
// placeholders stop restoring, visibly), which is the correct failure: a stale
// key can never silently decrypt into the wrong conversation, because GCM
// authenticates and `open` refuses.

const sessionKeyBytes = 32 // AES-256

var errNoKey = errors.New("session_key must be 32 bytes, hex or base64")

// parseSessionKey accepts hex or standard base64. Anything else is a
// configuration error, never a silently weaker key.
func parseSessionKey(s string) ([]byte, error) {
	if s == "" {
		return nil, errNoKey
	}
	if raw, err := hex.DecodeString(s); err == nil && len(raw) == sessionKeyBytes {
		return raw, nil
	}
	if raw, err := base64.StdEncoding.DecodeString(s); err == nil && len(raw) == sessionKeyBytes {
		return raw, nil
	}
	return nil, errNoKey
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// seal returns base64(nonce || ciphertext||tag).
//
// A fresh random nonce per write: GCM nonce reuse under one key leaks the
// keystream, so this must never become a counter derived from the session id.
func seal(key []byte, plaintext []byte) (string, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	out := gcm.Seal(nonce, nonce, plaintext, nil)
	return base64.StdEncoding.EncodeToString(out), nil
}

// open reverses seal. A wrong key, a truncated value or a tampered one all come
// back as an error — never as partial plaintext.
func open(key []byte, encoded string) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, err
	}
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	if len(raw) < gcm.NonceSize() {
		return nil, errors.New("sealed value too short")
	}
	nonce, body := raw[:gcm.NonceSize()], raw[gcm.NonceSize():]
	return gcm.Open(nil, nonce, body, nil)
}
