package main

import (
	"encoding/json"
	"sync"
	"time"
)

// The connector's only state, and the reason it needs any.
//
//  1. **The placeholder map.** A verdict carries span OFFSETS and no matched
//     text, by design — the platform must not become a copy of the data it
//     guards. So the party that already holds the plaintext does the masking and
//     keeps token->value itself. That party is this plugin.
//  2. **History has to stay masked.** An OpenAI client re-sends the whole
//     conversation and its own history holds the ORIGINAL plaintext — it never
//     saw our placeholders, because we restored them on the way back. Re-masking
//     known values with the SAME token is both the leak fix and what keeps the
//     model's context coherent across turns.
//  3. **Only what is NEW should be reported.** Without remembering which
//     tool_call ids and which user turn we already sent, every request would
//     re-report the entire history and the console would count one action once
//     per remaining turn.
//
// ⚠️ It CANNOT live in this process. Envoy gives every worker thread its own
// Wasm VM and round-robins connections across them, so turn 1 and turn 2 of one
// conversation land in different VMs — measured, not theoretical (workers 712
// then 701 on two consecutive requests). A Go global re-masks nothing on turn 2
// and re-reports the whole history as new.
//
// So the state is shared through Redis, SEALED (crypto.go): the store holds
// ciphertext only. The in-VM map below is a cache in front of it, not the
// source of truth.
//
// ⚠️ Concurrent turns of ONE conversation are last-write-wins. Turns of a chat
// are sequential by nature, so this is a real but narrow race: two in-flight
// requests of the same session can lose one side's newly learned pairs, which
// costs a re-mask, not a leak.

const (
	sessionTTL      = 30 * time.Minute // matches the runtime's run-pointer idle TTL
	maxSessions     = 4096
	maxTokens       = 256 // placeholders remembered per session
	maxTrackedCalls = 256 // tool_call ids remembered per session
)

type sessionState struct {
	ID        string
	ToolsHash string

	Mapping  map[string]string // token -> plaintext
	ByValue  map[string]string // plaintext -> token
	Counters map[string]int    // placeholder type -> highest number minted locally

	calls    map[string]bool
	results  map[string]bool
	userHash string

	dirty    bool
	lastSeen time.Time
}

// wire is what actually goes to the store, sealed. Short keys because every
// session pays for them on every turn.
type wire struct {
	M  map[string]string `json:"m,omitempty"`  // token -> plaintext
	C  map[string]int    `json:"c,omitempty"`  // local counters
	K  []string          `json:"k,omitempty"`  // tool_call ids seen
	R  []string          `json:"r,omitempty"`  // tool_result ids seen
	U  string            `json:"u,omitempty"`  // hash of the last reported user turn
	TH string            `json:"th,omitempty"` // hash of the declared tool set
}

func newSessionState(id string) *sessionState {
	return &sessionState{
		ID:       id,
		Mapping:  map[string]string{},
		ByValue:  map[string]string{},
		Counters: map[string]int{},
		calls:    map[string]bool{},
		results:  map[string]bool{},
		lastSeen: time.Now(),
	}
}

func (s *sessionState) encode() ([]byte, error) {
	w := wire{M: s.Mapping, C: s.Counters, U: s.userHash, TH: s.ToolsHash}
	for id := range s.calls {
		w.K = append(w.K, id)
	}
	for id := range s.results {
		w.R = append(w.R, id)
	}
	return json.Marshal(w)
}

func decodeSession(id string, blob []byte) *sessionState {
	st := newSessionState(id)
	var w wire
	if err := json.Unmarshal(blob, &w); err != nil {
		return st // an unreadable blob starts a fresh session, never a partial one
	}
	if w.M != nil {
		st.Mapping = w.M
		for token, value := range w.M {
			st.ByValue[value] = token
		}
	}
	if w.C != nil {
		st.Counters = w.C
	}
	for _, id := range w.K {
		st.calls[id] = true
	}
	for _, id := range w.R {
		st.results[id] = true
	}
	st.userHash, st.ToolsHash = w.U, w.TH
	return st
}

func (s *sessionState) seenCall(id string) bool   { return s.calls[id] }
func (s *sessionState) seenResult(id string) bool { return s.results[id] }

func (s *sessionState) markCall(id string) {
	if len(s.calls) >= maxTrackedCalls {
		s.calls = map[string]bool{}
	}
	s.calls[id] = true
	s.dirty = true
}

func (s *sessionState) markResult(id string) {
	if len(s.results) >= maxTrackedCalls {
		s.results = map[string]bool{}
	}
	s.results[id] = true
	s.dirty = true
}

// sawUserText answers "have we already reported this user turn?". A retry of the
// same request must not mint a second user_input, and an agent loop continuing
// with tool results re-sends the SAME last user message every time.
func (s *sessionState) sawUserText(text string) bool { return s.userHash == hashOf(text) }

func (s *sessionState) markUserText(text string) {
	s.userHash = hashOf(text)
	s.dirty = true
}

func (s *sessionState) setToolsHash(h string) {
	s.ToolsHash = h
	s.dirty = true
}

// nextNumber reserves the next placeholder number for a type. Only used when the
// verdict did not carry the runtime's own token (see redactionsFromVerdict).
func (s *sessionState) nextNumber(typeName string) int {
	s.Counters[typeName]++
	s.dirty = true
	return s.Counters[typeName]
}

// remember binds a value to a token for the rest of the session. A value that
// already has one keeps it — that is what makes turn 3's history mask to the
// same string the model saw in turn 1.
func (s *sessionState) remember(token, value string) {
	if len(s.Mapping) >= maxTokens {
		return
	}
	s.Mapping[token] = value
	s.ByValue[value] = token
	s.dirty = true
}

// redactions renders the session's whole map as masking instructions, so every
// resent turn of the history is masked with its established token.
func (s *sessionState) redactions() []Redaction {
	out := make([]Redaction, 0, len(s.ByValue))
	for value, token := range s.ByValue {
		out = append(out, Redaction{Token: token, Value: value})
	}
	return out
}

// --- the in-VM cache --------------------------------------------------------

var (
	sessionsMu sync.Mutex
	sessions   = map[string]*sessionState{}
)

func cachedSession(key string) *sessionState {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()
	if st, ok := sessions[key]; ok {
		if time.Since(st.lastSeen) < sessionTTL {
			st.lastSeen = time.Now()
			return st
		}
		delete(sessions, key)
	}
	return nil
}

func cacheSession(key string, st *sessionState) {
	sessionsMu.Lock()
	defer sessionsMu.Unlock()
	st.lastSeen = time.Now()
	if len(sessions) >= maxSessions {
		evictOldest(time.Now())
	}
	sessions[key] = st
}

// evictOldest drops expired sessions, and if none are expired, the single least
// recently used one. An evicted session degrades exactly like one that idled
// out: the shared copy in Redis is still authoritative.
func evictOldest(now time.Time) {
	oldestKey, oldest := "", now
	for k, st := range sessions {
		if now.Sub(st.lastSeen) >= sessionTTL {
			delete(sessions, k)
			continue
		}
		if st.lastSeen.Before(oldest) {
			oldestKey, oldest = k, st.lastSeen
		}
	}
	if len(sessions) >= maxSessions && oldestKey != "" {
		delete(sessions, oldestKey)
	}
}
