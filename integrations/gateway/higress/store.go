package main

import (
	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm"
	"github.com/higress-group/wasm-go/pkg/wrapper"
	"github.com/tidwall/resp"
)

// The shared session store: Redis, holding SEALED session blobs.
//
// Everything about why this exists is in session.go; everything about why it is
// sealed is in crypto.go. This file is only the plumbing, and its one rule is
// that a store failure must never fail the request — it degrades to the in-VM
// cache, which means "this turn does not re-mask history", not "this turn is
// refused".

const sessionKeyPrefix = "ogrsess:"

type store struct {
	redis wrapper.RedisClient
	key   []byte
	ttlS  int
}

// load hands the callback the session state for a conversation, from the in-VM
// cache when it is there and from Redis otherwise. The callback ALWAYS runs,
// with a fresh state if nothing could be read: a request never waits on a store
// that is down.
func (s *store) load(cacheKey, sessionID string, cb func(*sessionState)) {
	if st := cachedSession(cacheKey); st != nil {
		cb(st)
		return
	}
	if s == nil || s.redis == nil {
		cb(newSessionState(sessionID))
		return
	}
	err := s.redis.Get(sessionKeyPrefix+cacheKey, func(response resp.Value) {
		st := newSessionState(sessionID)
		if blob := response.String(); blob != "" {
			plain, err := open(s.key, blob)
			if err != nil {
				// A wrong key or a tampered value: start clean rather than guess.
				// Visible as un-restored placeholders, never as wrong plaintext.
				proxywasm.LogErrorf("[OGR-STORE] unsealing session failed: %v", err)
			} else {
				st = decodeSession(sessionID, plain)
			}
		}
		cacheSession(cacheKey, st)
		cb(st)
	})
	if err != nil {
		proxywasm.LogErrorf("[OGR-STORE] redis GET dispatch failed: %v", err)
		cb(newSessionState(sessionID))
	}
}

// save writes the session back, sealed, if anything changed. Fire-and-forget:
// the next turn reading a slightly stale map costs a re-mask, and blocking a
// user's request on a cache write costs the request.
func (s *store) save(cacheKey string, st *sessionState) {
	if st == nil || !st.dirty {
		return
	}
	cacheSession(cacheKey, st)
	st.dirty = false
	if s == nil || s.redis == nil {
		return
	}
	blob, err := st.encode()
	if err != nil {
		proxywasm.LogErrorf("[OGR-STORE] encoding session failed: %v", err)
		return
	}
	sealed, err := seal(s.key, blob)
	if err != nil {
		// ⚠️ Never fall back to writing the blob unsealed. The whole reason this
		// store is allowed to exist is that it holds ciphertext.
		proxywasm.LogErrorf("[OGR-STORE] sealing session failed, NOT storing: %v", err)
		return
	}
	if err := s.redis.SetEx(sessionKeyPrefix+cacheKey, sealed, s.ttlS,
		func(response resp.Value) {
			if e := response.Error(); e != nil {
				proxywasm.LogErrorf("[OGR-STORE] redis SETEX: %v", e)
			}
		}); err != nil {
		proxywasm.LogErrorf("[OGR-STORE] redis SETEX dispatch failed: %v", err)
	}
}
