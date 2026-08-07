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

// The chain lookup+publish, in ONE atomic step.
//
// Sequential GETs would be several round trips on the request path and, worse, would
// race: two concurrent turns of one conversation could both miss, both mint, and both
// publish — splitting the conversation exactly where it is busiest.
//
// ⚠️ Keys are Lua KEYS, never built inside the script, so a clustered Redis can route
// it. They share a hash tag (see `chainKey`) which is what puts them in one slot.
const chainScript = `
local n = tonumber(ARGV[3])
local sid
for i = 1, n do
  local hit = redis.call('GET', KEYS[i])
  if hit then sid = hit break end
end
if not sid then sid = ARGV[1] end
local writeK = KEYS[n + 1]
if writeK ~= '' then
  redis.call('SETEX', writeK, tonumber(ARGV[2]), sid)
end
return sid
`

// resolveSession decides WHICH conversation this request continues, then hands the
// callback its id.
//
// `minted` is used when nothing matched — a conversation's first turn, and the correct
// answer there. The callback ALWAYS runs: a store that is down degrades to "every
// request is its own session", which is the pre-chaining behaviour, never to a dropped
// request.
//
// ⚠️ The publish happens even on a miss, and that is what makes the NEXT turn findable.
// A version that only published on a hit would chain nothing, forever, silently.
func (s *store) resolveSession(scope string, digests []string, minted string, cb func(string)) {
	lookups := chainLookupDigests(digests)
	write := chainWriteDigest(digests)
	if s == nil || s.redis == nil || (len(lookups) == 0 && write == "") {
		cb(minted)
		return
	}
	keys := make([]interface{}, 0, len(lookups)+1)
	for _, d := range lookups {
		keys = append(keys, chainKey(scope, d))
	}
	if write != "" {
		keys = append(keys, chainKey(scope, write))
	} else {
		// The script still expects the slot; "" tells it there is nothing to publish.
		keys = append(keys, "")
	}
	err := s.redis.Eval(chainScript, len(keys), keys,
		[]interface{}{minted, s.ttlS, len(lookups)},
		func(response resp.Value) {
			if sid := response.String(); sid != "" {
				cb(sid)
				return
			}
			cb(minted)
		})
	if err != nil {
		proxywasm.LogErrorf("[OGR-STORE] redis EVAL dispatch failed: %v", err)
		cb(minted)
	}
}
