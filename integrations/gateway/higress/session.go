package main

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// The plugin's only state — and it lives for ONE REQUEST.
//
// ⚠️ This file used to be the reason the plugin needed Redis: the placeholder map,
// the already-reported marks and the conversation chain all had to survive across
// requests, and Envoy gives every worker thread its own Wasm VM. All of it moved to
// the runtime, which holds the session, numbers the placeholders, and answers each
// request with `modifications.spans` covering every occurrence of a known value IN
// THIS BODY — history included, because the whole conversation is in the body.
// Nothing here outlives the request. (v0.8 finished the retreat: the verdict no
// longer even echoes a session id, so there is no coordinate left to hold.)

// sessionState is the masking context for one request.
type sessionState struct {
	// Mapping is token -> plaintext, learned from the spans this request APPLIED
	// (the runtime's replacement token; the bytes it displaced). It is what restores
	// the model's reply: the model may echo `${OGR_EMAIL_1}` and the caller must
	// receive its own data back.
	Mapping map[string]string
}

// The most placeholders one request may carry. A body past this is not being
// redacted, it is being copied — and the runtime applies the same bound to what it
// returns.
const maxTokens = 256

func newSessionState() *sessionState {
	return &sessionState{Mapping: map[string]string{}}
}

// adopt records the token→value bindings a span application learned.
func (s *sessionState) adopt(learned map[string]string) {
	for token, value := range learned {
		if len(s.Mapping) >= maxTokens {
			return
		}
		if token != "" && value != "" {
			s.Mapping[token] = value
		}
	}
}

/**
 * The identity FLOOR: a stable, non-reversible id for a caller nothing else named.
 *
 * ⚠️ WHY IT IS NOT the runtime API key. That key authenticates the SENDER — this
 * gateway — so using it as the agent identity files every consumer behind one
 * proxy into a single inventory row: one agent, one policy resolution, and one
 * click that moves everybody. The credential the CLIENT presented is the finest
 * distinction a gateway without key-auth actually holds, so it is the one to use.
 *
 * ⚠️ The credential itself NEVER leaves this process. What ships is
 * `caller-<first 12 hex of sha256>` — enough to tell two callers apart, useless
 * for talking to the upstream. 48 bits keeps collisions negligible at any real
 * consumer count (a collision would silently merge two people's traffic, which is
 * the very bug this exists to prevent, so the extra 4 bytes are not cosmetic).
 *
 * ⚠️ Two honest limits, both of which key-auth removes:
 *   - a credential SHARED by a team is one caller here, correctly and unhelpfully;
 *   - ROTATING a credential mints a new agent row, because from the gateway's side
 *     a new secret is a new caller. The inventory gains a line; nothing breaks.
 *
 * ⚠️ It is a fingerprint of a secret, so anyone who ALREADY holds a given key can
 * confirm which row is theirs. That is the accepted cost of not inventing a
 * server-side mapping table; it discloses nothing to someone without the key.
 */
const callerPrefix = "caller-"

// 12 hex characters = 48 bits. See the collision note above.
const callerHexLen = 12

/**
 * The fingerprint itself, without the `caller-` dressing.
 *
 * ⚠️ Normalised through credentialValue first, so "Bearer sk-…" in one header
 * and a bare "sk-…" in another hash identically — otherwise the same caller
 * changes identity by moving their key between headers.
 */
func credentialFingerprint(credential string) string {
	sum := sha256.Sum256([]byte(credentialValue(credential)))
	return hex.EncodeToString(sum[:])[:callerHexLen]
}

/**
 * The credential itself, with any `Bearer ` scheme removed.
 *
 * ⚠️ A header of exactly "Bearer " trims to the SCHEME NAME, which has no space
 * left to split on — so without the second branch the word "bearer" gets
 * fingerprinted as if it were a secret, and every credential-less request in the
 * deployment shares one invented agent. That is the collapse this whole path
 * exists to remove, wearing a plausible id. Found by the test, not by review.
 */
func credentialValue(raw string) string {
	cred := strings.TrimSpace(raw)
	if i := strings.IndexByte(cred, ' '); i > 0 && strings.EqualFold(cred[:i], "bearer") {
		return strings.TrimSpace(cred[i+1:])
	}
	if strings.EqualFold(cred, "bearer") {
		return ""
	}
	return cred
}

// deriveCallerID reads the first credential header that carries anything and
// fingerprints it. `get` is injected so this is testable without a wasm host.
func deriveCallerID(get func(string) string, headers []string) string {
	if fp := callerFingerprint(get, headers); fp != "" {
		return callerPrefix + fp
	}
	return ""
}

// firstHeader returns the first non-empty value along a header chain — how the
// agent id and workspace resolve (the OGR spelling first, the MSE compatibility
// spelling second). `get` is injected so this is testable without a wasm host.
func firstHeader(get func(string) string, headers []string) string {
	for _, h := range headers {
		if v := strings.TrimSpace(get(h)); v != "" {
			return v
		}
	}
	return ""
}

// callerFingerprint is deriveCallerID without the prefix.
// "" when the request presented no credential at all.
func callerFingerprint(get func(string) string, headers []string) string {
	for _, h := range headers {
		// "Bearer sk-…" and a bare "sk-…" must fingerprint IDENTICALLY, or the
		// same caller changes identity by moving their key to another header.
		if cred := credentialValue(get(h)); cred != "" {
			return credentialFingerprint(cred)
		}
	}
	return ""
}
