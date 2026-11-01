package main

import (
	"encoding/binary"

	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm"
	"github.com/tidwall/gjson"
)

// WHAT THE RUNTIME SAYS IT WILL ACCEPT (plugin 3.8.0).
//
// The runtime bounds what one org may send — a whole-body cap it answers 413 to, and
// a per-KIND cap that decides whether an inline attachment's bytes are kept at all
// (`org_limits`, runtime migration 0065). Until now this plugin had no way to learn
// those numbers, so a deployment whose runtime accepts no images still paid to base64
// every screenshot across the wire, in front of a waiting caller, to have it recorded
// as declined at the far end.
//
// The heartbeat RESPONSE carries them (`GET /v1/limits` returns the same object), so
// learning them costs no extra call: `rememberLimits` stores what the beat answered
// in shared data, and `resolveMediaLimits` folds it into this plugin's own config on
// the request path.
//
// ⚠️⚠️ **`0` MEANS THE OPPOSITE THING ON EACH SIDE, AND THE TWO MEET IN ONE FUNCTION.**
// In THIS plugin's config, `media_max_bytes: 0` means *send every body verbatim* — no
// eliding at all. In the runtime's advertised limits, `0` means *this kind is refused*.
// Same literal, opposite meanings, one line apart. So the advertised value is kept in
// its own tri-state (`capUnknown` = never advertised) and is NEVER assigned into the
// configured field; `mediaLimit` returns an explicit `elideAll` flag rather than
// leaning on any number to carry that meaning.
//
// ⚠️ **ADVISORY, never authority.** The runtime enforces its own limits on every
// request whatever this plugin believes. What the advertisement buys is eliding
// LOCALLY instead of collecting 413s, and it must degrade to the configured behaviour
// the moment it is missing — a gateway that has never had a successful beat still has
// to report traffic exactly as 3.7.0 did.
//
// ⚠️ **`min(configured, advertised)`, never `max`.** Learning a larger cap must not
// raise an operator's own: someone who set `media_max_bytes` low made a bandwidth
// decision about THEIR link, and it is not the runtime's to overrule.

const (
	// Shared-data key for the advertised caps: five packed int64s, in kindOrder.
	skLimits = "ogr.limits"

	// "The runtime has never told us." Distinct from an advertised 0, which is a
	// statement — see the header. Never written into the blob; it is what a missing
	// or malformed blob resolves to.
	capUnknown = -1
)

// The blob's field order. ⚠️ POSITIONAL and frozen, like the counter slots: a
// reordering silently re-points every cap at the wrong kind, and nothing would fail.
var kindOrder = [5]string{"image", "audio", "video", "document", "file"}

// rememberLimits records the caps a heartbeat response advertised.
//
// ⚠️ Writes nothing when the response carries no `limits` — a runtime older than
// 0065 answers `{"ok":true}`, and treating that as "everything is refused" would
// stop a working deployment from reporting its attachments at all. Absent stays
// unknown, and unknown means "use the configured behaviour".
func rememberLimits(body []byte) {
	caps, ok := parseAdvertised(body)
	if !ok {
		return
	}
	buf := make([]byte, len(kindOrder)*8)
	for i := range kindOrder {
		binary.LittleEndian.PutUint64(buf[i*8:], uint64(caps[i]))
	}
	// ⚠️ Last write wins, no CAS retry loop: this is not a counter, every VM in the
	// process is writing the SAME answer from the same response, and a lost write
	// costs one heartbeat period of staleness.
	_ = proxywasm.SetSharedData(skLimits, buf, 0)
}

// parseAdvertised is the PURE half — no wasm host, so a unit test can reach it.
//
// ⚠️ That split is not tidiness. This plugin has already been bitten by a test that
// panicked for want of a host, and "what did the runtime tell us" has to be testable
// without one; the shared-data write above is the part that genuinely needs Envoy.
//
// `ok` is false when there is nothing to learn — a runtime older than 0065 answers
// `{"ok":true}` and naming no kind must NOT be read as "everything is refused", nor
// be allowed to overwrite what the last good beat told us.
func parseAdvertised(body []byte) (caps [5]int64, ok bool) {
	caps = [5]int64{capUnknown, capUnknown, capUnknown, capUnknown, capUnknown}
	media := gjson.GetBytes(body, "limits.media")
	if !media.IsObject() {
		return caps, false
	}
	for i, kind := range kindOrder {
		v := media.Get(kind)
		if !v.Exists() || v.Type != gjson.Number {
			continue
		}
		n := v.Int()
		if n < 0 {
			n = 0
		}
		caps[i] = n
		ok = true
	}
	return caps, ok
}

// advertisedCaps reads the blob back. Every entry is `capUnknown` when the runtime
// has never advertised, or when shared data will not cooperate.
func advertisedCaps() [5]int64 {
	out := [5]int64{capUnknown, capUnknown, capUnknown, capUnknown, capUnknown}
	data, _, err := proxywasm.GetSharedData(skLimits)
	if err != nil || len(data) != len(kindOrder)*8 {
		return out
	}
	for i := range kindOrder {
		out[i] = int64(binary.LittleEndian.Uint64(data[i*8:]))
	}
	return out
}

// mediaLimits is what the elider consults: this plugin's configured cap, plus
// whatever the runtime last advertised.
type mediaLimits struct {
	// The operator's own `media_max_bytes`. `0` = no eliding configured.
	configured int
	// Per kind, in kindOrder. `capUnknown` = never advertised, `0` = kind refused.
	advertised [5]int64
}

// resolveMediaLimits is called once per reported event, on the request path.
// `GetSharedData` is an in-process map read; this is not a callout.
func resolveMediaLimits(configured int) mediaLimits {
	return mediaLimits{configured: configured, advertised: advertisedCaps()}
}

// mediaLimit answers, for one kind: the byte ceiling above which a part is elided,
// and whether EVERY part of this kind should be elided regardless of size.
//
// The table this implements, in full, because the two `0`s are what make it subtle:
//
//	configured | advertised | result
//	-----------+------------+---------------------------------------------
//	0 (off)    | unknown    | no eliding            (3.7.0 behaviour)
//	0 (off)    | 0          | elide all             (the runtime refuses it)
//	0 (off)    | > 0        | limit = advertised
//	> 0        | unknown    | limit = configured    (3.7.0 behaviour)
//	> 0        | 0          | elide all
//	> 0        | > 0        | limit = min(both)
func (l mediaLimits) mediaLimit(kind string) (limit int, elideAll bool) {
	adv := int64(capUnknown)
	for i, k := range kindOrder {
		if k == kind {
			adv = l.advertised[i]
			break
		}
	}
	if adv == 0 {
		return 0, true
	}
	if adv == capUnknown {
		return l.configured, false
	}
	if l.configured <= 0 {
		return int(adv), false
	}
	if int64(l.configured) < adv {
		return l.configured, false
	}
	return int(adv), false
}

// scanFloor is the smallest part size that could possibly be elided, used only to
// skip the walk on a body that cannot contain one.
//
// Returns `(0, false)` when nothing can ever be elided — every kind unlimited — and
// `(n, true)` otherwise. ⚠️ A kind with `elideAll` forces a floor of 0: the part's
// size stops mattering, so the body's size cannot rule it out either.
func (l mediaLimits) scanFloor() (floor int, scan bool) {
	floor = -1
	for _, kind := range kindOrder {
		limit, all := l.mediaLimit(kind)
		if all {
			return 0, true
		}
		if limit <= 0 {
			continue // this kind is unbounded
		}
		if floor < 0 || limit < floor {
			floor = limit
		}
	}
	if floor < 0 {
		return 0, false
	}
	return floor, true
}
