package main

import (
	"crypto/sha256"
	"encoding/hex"

	"github.com/openguardrails/higress/protocol"
)

// WHICH CONVERSATION this request continues.
//
// A gateway sees one stateless request at a time. The session it belongs to used to be
// a HASH ANCHORED ON THE FIRST TURN — sha256(principal ‖ system ‖ first user message) —
// which is stable across the turns of one conversation and therefore looks right until
// you meet the two cases it cannot express:
//
//   - **A scheduled job sends the same first message every time.** Same principal, same
//     system prompt, same opening ⇒ the same id forever. Measured on 4 days of real
//     traffic: one "session" of 5337 events spanning 98 hours, its requests 29-30
//     minutes apart; 26 of the 48 long-lived sessions were on a fixed cadence like it.
//     They were never conversations — the key simply cannot separate them.
//   - **Two people opening with the same words** land in one session and NEVER diverge,
//     because nothing after the first turn feeds the key.
//
// So the id is CHAINED instead of anchored: each request looks up the conversation it
// continues by fingerprinting its own prefix, and publishes a fingerprint of itself for
// the next one. What that buys, both of which the anchor could not:
//
//   - a cron run separates by construction — its chain pointer has expired by the time
//     the next run arrives, so each execution is its own session;
//   - two identical openings diverge on their second turn, because the prefix that
//     identifies them has grown apart.
//
// The runtime does the same reassembly (`worker/services/sessionDerivation.ts`) for
// instrumentations that send no session_id at all. Doing it HERE is strictly better
// when we can: the gateway holds the whole message array, so it never has to guess.

const (
	// How many trailing turns a lookup may drop while hunting for the previous
	// request. Two covers ordinary chat (the reply plus the new question); the rest
	// covers a turn that appended a tool round trip to the transcript.
	maxTrailingTurns = 6
	// Field separator inside a digest. NUL, so a role and a body cannot be confused
	// for one another once whitespace has been collapsed.
	digestSep = "\x00"
)

// ⚠️ EXCLUDING THE SYSTEM PROMPT IS LOAD-BEARING, and leaving it in is the failure mode
// that would disable this whole mechanism without a single error. Practically every
// agent prompt carries a clock ("Current time: …"), so it differs on every request of
// one conversation; a digest including it never matches its own previous turn, every
// request opens a fresh session, and the result is indistinguishable from having no
// chaining at all. Nothing is lost: the chain is already scoped to one consumer.
//
// The exclusion is now structural rather than a filter: protocol.Conversation keeps the
// system prompt in its own field, so the turns a digest runs over cannot contain it.

// collapseSpaces folds every run of whitespace into one space and trims the ends, so
// the re-serialisation jitter between one request and the next cannot break a chain.
func collapseSpaces(s string) string {
	out := make([]byte, 0, len(s))
	space := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			space = true
			continue
		}
		if space && len(out) > 0 {
			out = append(out, ' ')
		}
		space = false
		out = append(out, c)
	}
	return string(out)
}

// prefixDigests returns the rolling prefix digests of a conversation: out[k]
// fingerprints its first k chainable turns, so out[0] is the empty prefix and out[n]
// the whole thing.
//
// Chained rather than re-hashed per prefix (h_k = sha256(h_{k-1} ‖ turn_k)), so every
// candidate a lookup can want falls out of one pass.
func prefixDigests(conv *protocol.Conversation) []string {
	digests := make([]string, 0, len(conv.Turns)+1)
	digests = append(digests, "")
	running := ""
	for _, t := range conv.Turns {
		h := sha256.New()
		h.Write([]byte(running))
		h.Write([]byte(digestSep))
		h.Write([]byte(t.Role))
		h.Write([]byte(digestSep))
		h.Write([]byte(collapseSpaces(t.Text)))
		// An action is part of what happened on that turn and the next request will
		// carry it back verbatim, so it belongs in the fingerprint.
		for _, a := range t.Actions {
			h.Write([]byte(digestSep))
			h.Write([]byte(a.Name))
			h.Write([]byte(digestSep))
			h.Write([]byte(collapseSpaces(a.Arguments)))
		}
		// So is an outcome. ⚠️ Without it, the two requests of one agent step — "here
		// are the results" and a retry of the same — fingerprint identically to the
		// step before them, and a long tool-only stretch of a run chains on a prefix
		// that stopped growing.
		if t.Outcome != nil {
			h.Write([]byte(digestSep))
			h.Write([]byte(t.Outcome.CallID))
			h.Write([]byte(digestSep))
			h.Write([]byte(collapseSpaces(t.Outcome.Text)))
		}
		running = hex.EncodeToString(h.Sum(nil))[:32]
		digests = append(digests, running)
	}
	return digests
}

// chainWriteDigest is the fingerprint this request PUBLISHES: its whole conversation,
// which is the prefix the next request of the same conversation will carry. "" when
// there is nothing chainable.
func chainWriteDigest(digests []string) string {
	if len(digests) == 0 {
		return ""
	}
	return digests[len(digests)-1]
}

// chainLookupDigests are the fingerprints this request LOOKS UP, longest prefix first.
//
// ⚠️ The FULL conversation is deliberately not a candidate, and that one rule is what
// keeps unrelated conversations apart. Every request carries at least one message — the
// new question — that no previous request could have published, so a match on the full
// list can only be a different conversation that happens to read identically. Without
// it, two people both opening with "你好" are spliced together on their second turn,
// which is the anchor scheme's bug in a new place.
//
// The empty prefix is excluded for the same reason: every conversation has one.
func chainLookupDigests(digests []string) []string {
	if len(digests) < 2 {
		return nil
	}
	shortest := len(digests) - 1 - maxTrailingTurns
	if shortest < 1 {
		shortest = 1
	}
	out := make([]string, 0, maxTrailingTurns)
	for k := len(digests) - 2; k >= shortest; k-- {
		if digests[k] != "" {
			out = append(out, digests[k])
		}
	}
	return out
}

// chainKey is where a conversation fingerprint is stored.
//
// ⚠️ The `{}` around the scope is a Redis Cluster HASH TAG, not decoration: a lookup
// reads several of these in one round trip, and without the tag they hash to different
// slots and the read is rejected outright on a clustered deployment.
//
// ⚠️ Scoped by CONSUMER. Two deployments of one harness open with the same default
// greeting, so an org-wide chain would splice strangers' conversations together.
func chainKey(scope, digest string) string {
	return "ogrconv:{" + scope + "}:" + digest
}
