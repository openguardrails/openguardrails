package main

import (
	"encoding/binary"
	"encoding/json"
	"net/http"
	"time"

	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm"
	"github.com/higress-group/wasm-go/pkg/wrapper"
)

// Liveness: telling the runtime this integration is still here.
//
// Silencing a PEP is the cheapest bypass of an altitude — uninstall the plugin and
// every request is unguarded, with nothing in the console to say so, because "no
// events" looks exactly like "a quiet afternoon". The heartbeat is what separates
// those two, and it is the one signal a PEP must send when it has nothing else to
// say.
//
// ⚠️ It beats as the SENSOR, not as an agent. A gateway fronts many agents, so
// attributing its liveness to one of them would report the others as covered by a
// sensor that never spoke for them (specification/enrollment-and-receipts.md).
//
// The counters are the second half. A runtime that only knows "the PEP is up"
// cannot see selective suppression; comparing what the PEP says it sent against
// what arrived can. `unchecked` is the one to watch — it counts requests that
// reached the model with no verdict behind them, which is what a tight timeout
// plus fail-open produces.

const (
	heartbeatPeriodMs  = 30000
	heartbeatTimeoutMs = 10000
)

// ⚠️ COUNTERS AND THE BEAT BOTH LIVE IN SHARED DATA, not in Go globals.
//
// Envoy gives every worker thread its own Wasm VM, so a package-level counter is
// one number per worker and the tick that reads it is running in yet another. The
// first cut of this shipped exactly that bug: heartbeats arrived on schedule with
// `{"evaluated":0,"ingested":0}` while the gateway was busily evaluating, which is
// worse than no counters — it is a reconciliation signal that always says "nothing
// happened".
//
// proxy-wasm's shared data is process-wide and CAS-guarded, which is what these
// two facts actually are: how much this Envoy has done, and when it last spoke.
//
// ⚠️ Process-wide, so a multi-POD gateway sends one beat per pod under one sensor
// id, and the runtime's row keeps the last one's counters. Liveness is still right
// (silence means every pod is gone); per-fleet reconciliation would need an
// instance identity, which the OGR sensor does not model yet.
const (
	skCounters = "ogr.counters" // four packed uint64s
	skBeatAt   = "ogr.beat_at"  // unix seconds of the last beat sent
	casRetries = 8
)

// The counter slots, in their packed order.
const (
	cntEvaluated = iota // verdicts asked for and received
	cntUnchecked        // requests that went through with NO verdict
	cntIngested         // events reported asynchronously
	cntMirrored         // batches copied to the candidate runtime
	// ⚠️ APPEND ONLY, and never reorder. The slots are packed positionally into one
	// shared-data blob; an insert in the middle silently re-reads every existing
	// counter as its neighbour. A length change is safe — `bump` starts from zero
	// when the stored blob is not `cntLen*8` bytes.
	cntStreamStopped   // streamed answers refused or retracted at end of stream
	cntUnresolvedSpans // redaction spans whose `path` named no text we hold
	cntUnreadable      // bodies we recognised and could not parse — NOT judged
	cntTruncated       // tools or actions dropped by a cap — NOT judged
	cntRefused         // turns this filter refused (block, fail-closed, partial-closed)
	cntLen
)

// counterNames is the ONLY place a slot gets a wire name, and it is indexed BY the
// slot so the two cannot drift.
//
// ⚠️ They did drift, and that is why this exists. `counters()` used to carry its own
// four-element list while the slots had grown to six — so `stream_stopped` and
// `unresolved_spans` were faithfully incremented on every occurrence and then dropped
// on the floor, and the runtime received a heartbeat that said they had never
// happened. A counter that is collected and not reported is worse than no counter: it
// reads as evidence of absence.
//
// This matters more now than it did, because `log.go` silences those warnings by
// default and the counter is what carries them instead.
var counterNames = [cntLen]string{
	cntEvaluated:       "evaluated",
	cntUnchecked:       "unchecked",
	cntIngested:        "ingested",
	cntMirrored:        "mirrored",
	cntStreamStopped:   "stream_stopped",
	cntUnresolvedSpans: "unresolved_spans",
	cntUnreadable:      "unreadable",
	cntTruncated:       "truncated",
	cntRefused:         "refused",
}

// bump adds to one counter. A lost increment under contention is acceptable —
// these numbers exist to spot a trend, and spinning on CAS inside a request is
// not worth a perfectly exact tally.
func bump(slot int, n uint64) {
	for i := 0; i < casRetries; i++ {
		data, cas, err := proxywasm.GetSharedData(skCounters)
		buf := make([]byte, cntLen*8)
		if err == nil && len(data) == cntLen*8 {
			copy(buf, data)
		}
		off := slot * 8
		binary.LittleEndian.PutUint64(buf[off:], binary.LittleEndian.Uint64(buf[off:])+n)
		if proxywasm.SetSharedData(skCounters, buf, cas) == nil {
			return
		}
	}
}

func counters() map[string]uint64 {
	// Every slot, always, even at zero: "this counter is 0" and "this build does not
	// have that counter" are different facts, and a runtime comparing beats across a
	// fleet needs to tell them apart.
	out := make(map[string]uint64, cntLen)
	for _, name := range counterNames {
		out[name] = 0
	}
	data, _, err := proxywasm.GetSharedData(skCounters)
	if err != nil || len(data) != cntLen*8 {
		return out
	}
	for slot, name := range counterNames {
		out[name] = binary.LittleEndian.Uint64(data[slot*8:])
	}
	return out
}

// claimBeat lets exactly ONE VM in this process send this period's beat.
//
// Every VM's tick fires, so without this the runtime receives one heartbeat per
// worker thread — eighteen of them on this box — each overwriting the last. The
// CAS makes the claim atomic: the loser simply does not send.
func claimBeat(now int64) bool {
	data, cas, err := proxywasm.GetSharedData(skBeatAt)
	var last int64
	if err == nil && len(data) == 8 {
		last = int64(binary.LittleEndian.Uint64(data))
	}
	if now-last < heartbeatPeriodMs/1000 {
		return false
	}
	buf := make([]byte, 8)
	binary.LittleEndian.PutUint64(buf, uint64(now))
	return proxywasm.SetSharedData(skBeatAt, buf, cas) == nil
}

// startHeartbeat registers the timer at plugin load. proxy-wasm has no threads:
// OnTick in the root context is the only clock available, and an HTTP callout
// from there is the ordinary way a plugin talks to anything on its own schedule.
func startHeartbeat(cfg *Config) {
	wrapper.RegisterTickFunc(heartbeatPeriodMs, func() {
		if claimBeat(time.Now().Unix()) {
			sendHeartbeat(cfg)
		}
	})
}

func sendHeartbeat(cfg *Config) {
	if cfg == nil || cfg.client == nil {
		return
	}
	c := counters()
	logInfof("[OGR-BEAT] sending: evaluated=%d unchecked=%d ingested=%d mirrored=%d refused=%d unreadable=%d",
		c["evaluated"], c["unchecked"], c["ingested"], c["mirrored"], c["refused"], c["unreadable"])
	payload, err := json.Marshal(map[string]any{
		"sensor": map[string]any{
			"id":      sensorName,
			"class":   sensorClass,
			"version": pluginVersion,
		},
		"interval_s": heartbeatPeriodMs / 1000,
		"counters":   counters(),
	})
	if err != nil {
		return
	}
	// ⚠️ Its OWN budget, not the PDP's. `timeout_ms` is tuned for a caller waiting
	// on a verdict — 5s by default — and a beat is nobody's latency: sharing that
	// budget just turned healthy heartbeats into 504s whenever the runtime was
	// briefly busy, i.e. exactly when liveness matters most.
	if err := cfg.client.Post(pathHeartbeat, ogrHeaders(*cfg), payload,
		func(status int, _ http.Header, body []byte) {
			// ⚠️ An ERROR, not a warning, and so never silenced by `log_level`. A beat
			// that does not arrive makes the platform mark this sensor dark, which is
			// indistinguishable from the plugin having been uninstalled — the exact
			// bypass the heartbeat exists to catch. It is also once per 30s, so it can
			// never be the thing that floods a log.
			if status != 200 {
				proxywasm.LogErrorf("[OGR-BEAT] status=%d body=%s", status, truncate(string(body), 160))
			}
		}, heartbeatTimeoutMs); err != nil {
		proxywasm.LogErrorf("[OGR-BEAT] dispatch failed: %v", err)
	}
}
