package main

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm"
	"github.com/higress-group/wasm-go/pkg/wrapper"
)

// ENFORCING ON A STREAM: HOLD THE TAIL, JUDGE ONCE.
//
// A buffered reply can be judged and refused before anyone sees it. A stream cannot:
// the first token is on the wire before there is anything to judge. This plugin used
// to square that by judging the answer every N characters and cutting on a hit, and
// the pipeline measured exactly that (`docs/STREAMING_GUARDRAIL.md`): at 25% of the
// reply visible, false positives on `mt_harm_correct` are 0.353 against 0.000 on the
// whole reply, all of it the answer that agrees on the surface and corrects
// underneath. Early judgement is a fit prefilter and an unfit blocking criterion.
// v0.7's replacement — two lanes picked by the runtime (`output_mode`), interim
// `ogr-partial` evaluates, a final /v1/ingest report — cost a round-trip per
// chunk-batch and a second event channel, and v0.8 deleted all three.
//
// What v0.8 specifies instead (runtime-api § streaming), and what this file is:
//
//  1. Forward the stream as it arrives, but WITHHOLD the final `stream_tail_chars`
//     of client-visible content (reference default 200).
//  2. At stream end, reassemble the COMPLETE response and submit it as the step's
//     one `step/response` evaluate — the canonical shape, with transcribed usage
//     and observed timing, because a stream has no single raw body to forward.
//  3. `allow` → release the held tail. `block` → drop the tail and cut the stream,
//     so the answer never completes as sent.
//
// The evaluate round-trip delays only the tail, and TOOL CALLS NEVER EXECUTE BEFORE
// THE VERDICT: a provider stream only completes tool calls at its end, so the frames
// that would let a client act — argument completions, `finish_reason`, `[DONE]` —
// are always inside the held tail. The accepted cost, stated by the spec rather
// than papered over: prose ahead of the tail has already been seen, so a block on
// a stream that already released bytes is a RETRACTION, not a secret kept.
//
// ⚠️ The tail is counted in UTF-8 BYTES of content (text, reasoning, tool-call
// arguments — never SSE framing), and it is a floor: release granularity is the
// chunk, so what is withheld is "at least the tail", not "exactly the tail". Bytes
// rather than code points is a deliberate simplification — on multi-byte text the
// same setting withholds fewer CHARACTERS, and a deployment that cares sets the
// knob higher. The enforcement property does not depend on the count: the final
// chunk is never released before the verdict, whatever the tail says.
//
// ⚠️ A response the client did not ask to stream (`stream: false` upstream of an
// armed pause, or a provider that answered JSON to a stream request) has no tail
// worth releasing early — partial JSON is useless to a client — so it degenerates
// to holding everything, which is the spec's own limit case (`tail = ∞` is
// buffering).
//
// ⚠️ The mechanism rests on `NeedPauseStreamingResponse` + injection. Once the
// response is paused EVERY chunk stops at this filter and the returned slice is not
// written — injection is the only way bytes reach the caller. That is why the pause
// is armed in the REQUEST phase (armTailHold), before there is a first chunk to be
// late for, and why every terminal path below MUST end in an injection with
// `endStream: true` — a branch that returns without one leaves the caller hanging
// until its own timeout, which is a worse failure than either verdict.

// tailHold is the withholding buffer for one response. The queue half is pure
// (no proxywasm), so the release arithmetic is testable without a gateway.
type tailHold struct {
	// tail is how many content bytes must remain withheld; < 0 means hold
	// everything (the non-SSE degenerate case).
	tail int
	// sse records whether the response is a real event stream — it decides which
	// shape a refusal takes when nothing has been released yet.
	sse bool

	segs     []heldSeg
	released bool
}

// heldSeg is one processed chunk awaiting release, tagged with the cumulative
// client-visible content total at the moment it was produced. The content that
// arrived AFTER a segment is (current total − its tag); once that reaches the
// configured tail, releasing the segment still leaves at least the tail withheld.
type heldSeg struct {
	bytes      []byte
	cumContent int
}

func newTailHold(tail int, sse bool) *tailHold {
	if !sse {
		tail = -1 // no frames to release early; hold the whole reply
	}
	return &tailHold{tail: tail, sse: sse}
}

// push queues one processed chunk and returns the prefix now safe to release —
// every queued segment that already has at least `tail` content bytes behind it.
// The FINAL chunk must not come through here (see judgeFinal): it is queued by the
// caller and released only by the verdict.
func (h *tailHold) push(out []byte, cumContent int) [][]byte {
	h.add(out, cumContent)
	if h.tail < 0 {
		return nil
	}
	var release [][]byte
	for len(h.segs) > 0 && cumContent-h.segs[0].cumContent >= h.tail {
		release = append(release, h.segs[0].bytes)
		h.segs = h.segs[1:]
		h.released = true
	}
	return release
}

/*
 * pushHead queues a chunk and releases only while fewer than `budget` content bytes
 * have gone out — the SPECULATIVE head (see headReleaseBytes).
 *
 * ⚠️ The tail rule still applies on top, so this can only ever release LESS than the
 * ordinary arithmetic would. That ordering is what produces the clean-refusal property
 * for short answers: with `total <= tail` the inner push releases nothing at all,
 * whatever the head budget says.
 */
func (h *tailHold) pushHead(out []byte, cumContent, budget int, released *int) [][]byte {
	if *released >= budget {
		h.add(out, cumContent)
		return nil
	}
	segs := h.push(out, cumContent)
	for _, seg := range segs {
		*released += len(seg)
	}
	return segs
}

// release drains whatever the tail arithmetic now permits, queueing nothing new. The
// entry point for a verdict that arrives mid-stream and lifts the head budget.
func (h *tailHold) release(cumContent int) [][]byte {
	if h.tail < 0 {
		return nil
	}
	var out [][]byte
	for len(h.segs) > 0 && cumContent-h.segs[0].cumContent >= h.tail {
		out = append(out, h.segs[0].bytes)
		h.segs = h.segs[1:]
		h.released = true
	}
	return out
}

// add queues a chunk without releasing anything — the isLast entry point.
func (h *tailHold) add(out []byte, cumContent int) {
	if len(out) == 0 {
		return
	}
	h.segs = append(h.segs, heldSeg{bytes: out, cumContent: cumContent})
}

// held concatenates everything still withheld, for release on allow.
func (h *tailHold) held() []byte {
	var out []byte
	for _, s := range h.segs {
		out = append(out, s.bytes...)
	}
	return out
}

// drop discards the withheld tail — the block path.
func (h *tailHold) drop() { h.segs = nil }

// sawRelease reports whether any byte has already reached the caller, which is
// what decides between a true refusal and a retraction.
func (h *tailHold) sawRelease() bool { return h.released }

// armTailHold takes ownership of the response stream for an enforced streaming
// request, so the end-of-stream judgement has somewhere to put its answer.
//
// Called during the REQUEST phase (the input-verdict callback, or the fail-open
// resume) — `NeedPauseStreamingResponse` must be set before the response phase
// begins, which is also the one place with no response status to check yet; the
// non-completion escape hatch lives in onStreamingResponseBody instead.
//
// ⚠️ Armed on the fail-open resume too, deliberately. v0.7 only armed after a
// successful input verdict, so a request that passed UNCHECKED also streamed its
// answer back unenforced — two halves lost to one transport failure. The two step
// halves are judged independently; losing the first is no reason to forfeit the
// second.
func armTailHold(ctx wrapper.HttpContext, cfg Config, rs *reqState) {
	if cfg.mode != modeEnforce || !rs.streaming {
		return
	}
	rs.owned = true
	ctx.NeedPauseStreamingResponse()
}

// holdChunk is the streaming body callback once the tail-hold owns the flow. It
// returns the bytes the wrapper should write, which is always none — everything
// reaches the caller through injection instead.
func holdChunk(ctx wrapper.HttpContext, cfg Config, rs *reqState, sp *streamProcessor,
	out []byte, isLast bool) []byte {
	if rs.hold == nil {
		rs.hold = newTailHold(cfg.streamTailChars, ctx.GetBoolContext(ctxStreaming, true))
	}
	rs.sp = sp
	if !isLast {
		switch {
		case !rs.spec || rs.input == inputAllow:
			// 3.0.x behaviour, and the state a speculative step reaches the moment its
			// deep verdict allows: ordinary tail arithmetic.
			emit(rs, rs.hold.push(out, sp.ContentBytes()))
		case rs.input == inputPending:
			// ⚠️ THE HEAD, and it is bounded by a CONSTANT rather than by how slow the
			// judge is. With no bound the exposure is `judge latency × token rate` and
			// drifts with the caller's context size — a coding agent shipping 64 KB of
			// conversation would leak proportionally more than a chatbot for the same
			// setting. See headReleaseBytes.
			emit(rs, rs.hold.pushHead(out, sp.ContentBytes(), headReleaseBytes, &rs.released))
			keepalive(rs)
		default: // inputClamped
			// Nothing more reaches the caller. The answer is still reassembled — it has
			// to be judged whole at end of stream — it just stops being delivered.
			rs.hold.add(out, sp.ContentBytes())
			keepalive(rs)
		}
		return nil
	}
	// The stream's last chunk is queued and NEVER released by arithmetic: whatever
	// the configured tail, the frames that complete the answer wait for the verdict.
	rs.hold.add(out, sp.ContentBytes())
	rs.ended = true
	/*
	 * ⚠️ **THE FINAL JUDGEMENT WAITS FOR THE REQUEST HALF**, and the case that makes
	 * this necessary is the common one rather than a corner: an unsafe question whose
	 * model refuses on its own produces a five-token answer, so the stream ends while
	 * the deep lane is still in flight. Firing here would put two evaluates for ONE
	 * step to the runtime concurrently — and the runtime's ledger assignment is not
	 * built for that. `settleInput` runs it instead, when the verdict lands.
	 */
	if rs.spec && rs.input == inputPending {
		return nil
	}
	judgeFinal(ctx, cfg, rs, sp)
	return nil
}

/*
 * headReleaseBytes — how much of a streamed answer may reach the caller BEFORE the
 * request has been judged. Counted in the same unit as the tail: UTF-8 bytes of
 * client-visible content, never SSE framing.
 *
 * ⚠️ **A CONSTANT, deliberately not configuration.** Bounding it is what makes the
 * exposure independent of judge latency; a per-deployment value would put that drift
 * straight back. 64 bytes is one or two frames — enough for a client to render "the
 * stream started", under one sentence of leak.
 *
 * ⚠️ **It composes with the tail, and the result is a gift.** Released content is
 * `max(0, min(head, total − tail))`, so an answer shorter than head+tail releases
 * NOTHING, `sawRelease()` stays false, and `finishBlocked` takes the CLEAN REFUSAL
 * branch instead of the retraction one. The case that matters most — unsafe question,
 * model refuses on its own, one short sentence — lands there by arithmetic, with no
 * special case anywhere.
 */
const headReleaseBytes = 64

// keepaliveAfter is how long a clamped stream may go silent before this filter puts a
// comment frame on the wire.
//
// ⚠️ Not cosmetic. A clamped stream can be silent for the whole of a long generation
// (a coding agent runs 30s+), and a client reading an already-open SSE stream that goes
// quiet for that long is cut by its own or an intermediary's idle timeout — which reads
// as the gateway hanging, the exact failure the non-completion escape hatch exists to
// prevent elsewhere. An SSE comment resets every read timer and no client parses it.
//
// ⚠️ Driven by UPSTREAM CHUNKS, not by a timer: proxy-wasm has no per-stream clock, and
// it needs none — the ticks we need are exactly the moments the model is producing.
// An upstream that has itself gone silent is not ours to paper over.
const keepaliveAfter = 10 * time.Second

func keepalive(rs *reqState) {
	if rs.hold == nil || !rs.hold.sse {
		return // a JSON reply has no comment syntax to hide a keepalive in
	}
	now := time.Now()
	if rs.lastOut.IsZero() {
		rs.lastOut = now
		return
	}
	if now.Sub(rs.lastOut) < keepaliveAfter {
		return
	}
	rs.lastOut = now
	if err := proxywasm.InjectEncodedDataToFilterChain([]byte(": ogr\n\n"), false); err != nil {
		proxywasm.LogErrorf("[OGR-TAIL] keepalive inject failed: %v", err)
	}
}

// emit writes released segments to the caller and stamps the keepalive clock.
func emit(rs *reqState, segs [][]byte) {
	for _, seg := range segs {
		if err := proxywasm.InjectEncodedDataToFilterChain(seg, false); err != nil {
			proxywasm.LogErrorf("[OGR-TAIL] inject failed: %v", err)
		}
		rs.lastOut = time.Now()
	}
}

/*
 * settleInput records the deep request-half verdict and unblocks whatever was waiting
 * on it. Called exactly once per speculative step, from the deep lane's callback.
 *
 * ⚠️ Everything here has to tolerate arriving BEFORE the response phase began (the
 * common case on a fast judge), DURING it, or AFTER end of stream. The three are
 * distinguished by `rs.hold == nil`, `!rs.ended` and `rs.ended`; none of them is an
 * error, and the last one is what a short refusal produces.
 */
func settleInput(ctx wrapper.HttpContext, cfg Config, rs *reqState, state inputState) {
	if rs.input != inputPending {
		return // one verdict per step; a second would re-release a dropped tail
	}
	rs.input = state

	/*
	 * ⚠️ Nothing to do if the response never became ours. A non-200 upstream (a 503, a
	 * key-auth 401, a limiter 429) sets `ctxNotModel` and the stream is passed through
	 * unheld — injecting into it here would be writing into a chain this filter does
	 * not own. `answered` is the twin case: this filter already produced the whole
	 * reply itself.
	 */
	if ctx.GetBoolContext(ctxNotModel, false) || ctx.GetBoolContext(ctxAnswered, false) {
		return
	}
	if rs.ended {
		judgeFinal(ctx, cfg, rs, rs.sp)
		return
	}
	if state == inputAllow && rs.hold != nil && rs.sp != nil {
		// Release whatever the tail arithmetic now permits — the head budget stopped
		// applying the moment the request was judged.
		emit(rs, rs.hold.release(rs.sp.ContentBytes()))
	}
}

// judgeFinal puts the COMPLETE answer to the PDP — the step's one and only
// response-side evaluate — and finishes the stream with what the verdict says.
func judgeFinal(ctx wrapper.HttpContext, cfg Config, rs *reqState, sp *streamProcessor) {
	if sp == nil {
		rs.finishAllow()
		return
	}
	out := sp.Result()
	if out.Empty() {
		// ⚠️ Nothing said, or nothing READABLE — SawBytes is what separates them, and
		// only the second is a hole. An unreadable reply is a reply this plugin
		// cannot judge, which under fail-closed must not go through: "could not
		// look" is not "found nothing" (degraded-mode.md says it is the same
		// situation as an outage, at a different size).
		if sp.SawBytes() {
			reportUnreadableStream(rs, sp)
			if cfg.failClosed {
				// A reply we could not read is a reply we could not judge, so under
				// `closed` this is a refusal like any other and belongs in `refused`
				// as well as `unreadable` — the two answer different questions ("what
				// did this filter stop" vs "what could it not parse"). 3.0.1.
				bump(cntRefused, 1)
				rs.finishBlocked(unreadMessage)
				return
			}
		}
		rs.finishAllow()
		return
	}

	// ⚠️ The WHOLE reply in one event: the prose, the reasoning and every tool call,
	// as the one generation they are — the canonical shape, because a stream has no
	// single raw body to forward. Usage is the provider's own counters transcribed
	// (absent when it reported nothing); timing is what the byte path observed.
	e := responseEventCanonical(rs.derive, canonicalOf(rs, out, sp.Timing()))
	mirrorEvent(cfg, e)

	payload, err := json.Marshal(e)
	if err != nil {
		rs.finishAllow()
		return
	}
	err = cfg.client.Post(cfg.evaluatePath, ogrHeaders(cfg), payload,
		func(status int, _ http.Header, respBody []byte) {
			if status != 200 {
				// Fail mode decides, exactly as it does on the request side. Note the
				// asymmetry the medium forces: failing CLOSED after bytes have gone out
				// can only retract, because the head of the answer has been read.
				evaluateFailed("TAIL", status, cfg.failClosed)
				if cfg.failClosed {
					rs.finishBlocked(failMessage)
					return
				}
				rs.finishAllow()
				return
			}
			v := parseVerdict(respBody)
			// A 200 that is not a verdict is a FAILURE, not an allow — see verdict.Usable.
			if !v.Usable() {
				logConditionf("tail.nodecision", "[OGR-TAIL] evaluate returned 200 with no decision (%d bytes)",
					len(respBody))
				evaluateFailed("TAIL", 0, cfg.failClosed)
				if cfg.failClosed {
					rs.finishBlocked(failMessage)
					return
				}
				rs.finishAllow()
				return
			}
			bump(cntEvaluated, 1)
			if v.Stops() {
				// ⚠️ BOTH counters, deliberately. `stream_stopped` (bumped inside
				// finishBlocked) says a stream ended early; `refused` says this filter
				// refused something. Every OTHER refusal on this path already counts in
				// both — evaluateFailed and partiallyJudged bump `refused` and then call
				// finishBlocked — so a verdict block counting only one of them made the
				// plain "the runtime said no" case the single refusal shape missing from
				// `refused`. Fixed in 3.0.1 together with the buffered twin at
				// main.go's onResponseBody.
				bump(cntRefused, 1)
				rs.finishBlocked(v.Reason())
				return
			}
			if partiallyJudged("TAIL", v, cfg.failClosed) {
				rs.finishBlocked(partialMessage)
				return
			}
			// ⚠️ Spans against a CANONICAL payload cannot be spliced into SSE frames —
			// the canonical text exists nowhere in the stream's bytes. They are counted
			// as unresolved rather than applied somewhere else; the value still never
			// reached the caller un-flagged (the finding exists), it is the in-place
			// masking that a stream cannot deliver.
			if spans := v.Spans(); len(spans) > 0 {
				logUnresolvedSpans(len(spans))
			}
			rs.finishAllow()
		}, cfg.timeoutMs)
	if err != nil {
		logConditionf("tail.dispatch", "[OGR-TAIL] final evaluate dispatch failed: %v", err)
		evaluateFailed("TAIL", 0, cfg.failClosed)
		if cfg.failClosed {
			rs.finishBlocked(failMessage)
			return
		}
		rs.finishAllow()
	}
}

// finishAllow releases the held tail and ends the stream.
func (rs *reqState) finishAllow() {
	var body []byte
	if rs.hold != nil {
		body = rs.hold.held()
	}
	if err := proxywasm.InjectEncodedDataToFilterChain(body, true); err != nil {
		proxywasm.LogErrorf("[OGR-TAIL] final inject failed: %v", err)
	}
}

// finishBlocked ends a stream the verdict (or fail-closed) refused: the held tail
// is dropped, so the answer never completes as the model sent it.
//
// Two endings, decided by whether any byte already reached the caller:
//
//   - nothing released yet (short stream, non-SSE reply, or a tail larger than the
//     answer): we still own every byte, so the caller reads a REFUSAL as the whole
//     answer — a true block, in the caller's own protocol.
//   - bytes already out: the head has been read and cannot be un-delivered; the
//     stream is CUT with the protocol's retraction frame (`content_filter` /
//     `refusal` stop) so a client takes the message back instead of hanging on a
//     half-open stream — and the withheld finish frames and tool-call completions
//     never leave, so nothing acts on the answer.
func (rs *reqState) finishBlocked(reason string) {
	bump(cntStreamStopped, 1)
	sse := true
	if rs.hold != nil {
		sse = rs.hold.sse
		if !rs.hold.sawRelease() {
			rs.hold.drop()
			refusal := rs.proto.Refuse(rs.model, reason)
			if sse {
				refusal = rs.proto.RefuseStream(rs.model, reason)
			}
			if err := proxywasm.InjectEncodedDataToFilterChain([]byte(refusal), true); err != nil {
				proxywasm.LogErrorf("[OGR-TAIL] refusal inject failed: %v", err)
			}
			return
		}
		rs.hold.drop()
	}
	if err := proxywasm.InjectEncodedDataToFilterChain(
		[]byte(rs.proto.Retract(rs.model)), true); err != nil {
		proxywasm.LogErrorf("[OGR-TAIL] retraction inject failed: %v", err)
	}
}
