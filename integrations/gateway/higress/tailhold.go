package main

import (
	"encoding/json"
	"time"

	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm"
	"github.com/higress-group/wasm-go/pkg/wrapper"
	"github.com/openguardrails/higress/protocol"
)

// ENFORCING ON A STREAM: RELEASE A BOUNDED HEAD, HOLD THE REST, JUDGE ONCE.
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
// So the answer is judged ONCE, whole, at end of stream — and the only remaining
// question is how much of it may be on the wire by then:
//
//  1. Forward at most `stream_head_release_bytes` of client-visible content (default
//     32) and WITHHOLD everything after it.
//  2. At stream end, reassemble the COMPLETE response and submit it as the step's
//     one `step/response` evaluate — the canonical shape, with transcribed usage
//     and observed timing, because a stream has no single raw body to forward.
//  3. `allow` → release everything held. `block` → drop it and cut the stream, so
//     the answer never completes as sent.
//
// ⚠️⚠️ **THE BOUND IS MEASURED FROM THE HEAD, AND THAT INVERSION IS THE WHOLE POINT
// (3.10.0).** Until now the knob was `stream_tail_chars` — withhold the LAST 200
// bytes — whose guarantee is "at least 200 bytes withheld" and which therefore says
// NOTHING about exposure: what reaches the caller is `total − 200`, unbounded in the
// length of the answer. Measured on this lab: a ~900-byte answer to a prohibited
// question was delivered essentially whole and then retracted, because the verdict
// cannot exist before the last token. Bounding the HEAD instead makes exposure a
// CONSTANT, independent of both the answer's length and the judge's latency — which
// is the argument the deleted `headReleaseBytes` constant already made for its own
// narrow window, taken to the whole stream.
//
// ⚠️ **IT IS A CEILING, NOT A FLOOR, and that is a change of kind.** A frame is
// released only if the content it completes still fits the budget, so the release
// never overshoots the way the tail arithmetic did.
//
// ⚠️⚠️ **AND THE UNIT HAD TO BECOME THE FRAME, OR THE BUDGET IS UNSPENDABLE.** The
// tail released in whole CHUNKS, which was invisible at 200-counted-from-the-end and
// fatal at 32-counted-from-the-start: measured on this lab, ONE upstream chunk is
// ~16 KB carrying **329 content bytes**, so nothing smaller than a third of the
// answer could ever be expressed and a 32-byte budget silently behaved as 0 — full
// buffering, TTFT unchanged, the very thing the number was chosen to avoid. The
// scanner splits its output at frame boundaries now (`protocol.Segment`) and the
// hold releases those. A FRAME, never a line: a `data:` line is inert until its
// blank terminator, so releasing one without the other spends budget on bytes the
// client cannot render.
//
// ⚠️ **32 BYTES IS A LIVENESS TOKEN, NOT A DELIVERY.** It is ~10 ASCII characters or
// ~10 Chinese ones: enough that a client renders "the stream started" and its own
// TTFT measurement is honest, small enough that a refusal is a retraction of one
// fragment rather than of the answer. Bytes rather than code points is deliberate —
// on multi-byte text the same setting releases fewer CHARACTERS, which errs toward
// less exposure. Counted in CONTENT bytes (text, reasoning, tool-call arguments),
// never SSE framing: opening frames that carry no content are free, so the stream
// looks alive immediately whatever the budget.
//
// ⚠️ **THE ENFORCEMENT PROPERTY DOES NOT REST ON THE NUMBER.** The final chunk is
// queued by `add()` and released only by the verdict, whatever the budget says, and
// TOOL CALLS NEVER EXECUTE BEFORE THE VERDICT: a provider stream only completes tool
// calls at its end, so argument completions, `finish_reason` and `[DONE]` are always
// inside the held remainder. `0` is a real value meaning "release nothing" — a
// spinner until the whole judged answer arrives, and every block a CLEAN refusal
// because `sawRelease()` never goes true.
//
// ⚠️ **THE RELEASE NO LONGER CONSULTS THE REQUEST HALF, IN THE `allow` DIRECTION
// (3.10.0).** A request judged clean lifts nothing: the RESPONSE is unjudged until
// the end of the stream whatever the request half said, so the budget that bounds
// response exposure cannot be a function of it. The one surviving coupling is the
// `inputClamped` arm in holdChunk, which only ever TIGHTENS.
//
// ⚠️ A response the client did not ask to stream (`stream: false` upstream of an
// armed pause, or a provider that answered JSON to a stream request) has no head
// worth releasing early — partial JSON is useless to a client — so it degenerates
// to holding everything, which is the spec's own limit case (buffering).
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
//
// ⚠️ The NAME still says tail because what is withheld is still the tail of the
// answer; what moved in 3.10.0 is where the boundary is measured FROM.
type tailHold struct {
	// head is the most client-visible content, in UTF-8 bytes, that may reach the
	// caller before the end-of-stream verdict; < 0 means release nothing at all (the
	// non-SSE degenerate case). 0 is a real setting with the same effect, chosen
	// rather than fallen into.
	head int
	// sse records whether the response is a real event stream — it decides which
	// shape a refusal takes when nothing has been released yet.
	sse bool

	segs     []heldSeg
	released bool
	// releasedCalls records that a released segment carried tool-call bytes, i.e.
	// the client may hold a partial call. It is what forbids the soft ending.
	releasedCalls bool
	// sawCalls is set by the chunk lane before each push — see streamProcessor.SawCalls.
	sawCalls bool
}

// heldSeg is one processed chunk awaiting release, tagged with the cumulative
// client-visible content total at the moment it was produced — which is exactly the
// exposure the caller would hold if this segment were released, so the budget test
// is a comparison against that tag and needs no running counter beside it.
type heldSeg struct {
	bytes      []byte
	cumContent int
	// afterCalls records that tool-call bytes were already in the decoder when this
	// segment was produced. Carried per segment rather than as one flag because what
	// matters is whether a segment CARRYING call bytes was RELEASED, not whether the
	// reply ever had a call — every refused tool call has one by definition.
	afterCalls bool
}

func newTailHold(head int, sse bool) *tailHold {
	if !sse {
		head = -1 // no frames worth releasing early; hold the whole reply
	}
	return &tailHold{head: head, sse: sse}
}

// push queues one processed chunk and returns the prefix now safe to release — every
// queued segment whose completed content still fits inside the head budget.
//
// ⚠️ A CEILING, not a floor. `cumContent` is the exposure that releasing this segment
// would produce, so `<= head` never overshoots: a frame that would carry the caller
// past the bound is held WHOLE rather than trimmed, because an SSE frame cut in half
// is not a frame. Once the front segment fails the test every later one fails it too
// (cumContent is non-decreasing), so the budget, once spent, stays spent.
//
// ⚠️ Contentless frames (the opening role delta, a keepalive comment, usage-only
// framing) carry the PRECEDING cumContent and so ride out for free while the budget
// is unspent — which is what makes a small budget still look like a live stream.
//
// The final chunk's frames must not come through here (see judgeFinal): they are
// queued by the caller and released only by the verdict.
func (h *tailHold) push(out []byte, cumContent int) [][]byte {
	h.add(out, cumContent)
	if h.head < 0 {
		return nil
	}
	var release [][]byte
	for len(h.segs) > 0 && h.segs[0].cumContent <= h.head {
		release = append(release, h.segs[0].bytes)
		// ⚠️ Once a segment carrying tool-call bytes has gone out, the client may hold
		// a partial call and the stream can no longer be ended on a normal stop.
		if h.segs[0].afterCalls {
			h.releasedCalls = true
		}
		h.segs = h.segs[1:]
		h.released = true
	}
	return release
}

// add queues a chunk without releasing anything — the isLast entry point.
func (h *tailHold) add(out []byte, cumContent int) {
	if len(out) == 0 {
		return
	}
	h.segs = append(h.segs, heldSeg{bytes: out, cumContent: cumContent, afterCalls: h.sawCalls})
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

// mayEndSoftly reports whether a refused stream can still be ended on this
// protocol's normal completion — nothing released at all, or nothing released that
// could have become an actionable tool call.
func (h *tailHold) mayEndSoftly() bool { return !h.released || !h.releasedCalls }

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
	segs []protocol.Segment, isLast bool) []byte {
	if rs.hold == nil {
		rs.hold = newTailHold(cfg.streamHeadReleaseBytes, ctx.GetBoolContext(ctxStreaming, true))
	}
	rs.sp = sp
	// Stamped BEFORE the push so each segment records the state at the moment it was
	// produced — see heldSeg.afterCalls.
	rs.hold.sawCalls = sp.SawCalls()
	if !isLast {
		/*
		 * ⚠️ ONE ARM, and the request half no longer appears in it (3.10.0). The head
		 * budget bounds RESPONSE exposure, and the response is unjudged until the end
		 * of the stream whatever the request half decided — so an `allow` landing here
		 * lifts nothing. What it replaced released `total − tail` bytes, i.e. the whole
		 * answer, the moment the request came back clean.
		 */
		clamped := rs.spec && rs.input == inputClamped
		for _, seg := range segs {
			if clamped {
				/*
				 * ⚠️ THE ONE SURVIVING COUPLING, and it only ever TIGHTENS. The deep
				 * verdict refused the REQUEST, so the answer being generated came out of
				 * a prompt we judged unsafe: unspent head budget is forfeit. The answer
				 * is still reassembled — it has to be judged whole at end of stream — it
				 * just stops being delivered. Asymmetric on purpose: tightening on a
				 * block is safe at any time, loosening on an allow is what this release
				 * removed.
				 */
				rs.hold.add(seg.Bytes, seg.Content)
				continue
			}
			emit(rs, rs.hold.push(seg.Bytes, seg.Content))
		}
		/*
		 * ⚠️ EVERY chunk, not just the clamped ones. With the bound at the head a
		 * stream goes quiet after ~32 bytes and stays quiet for the whole generation,
		 * so what used to be the clamped path's corner case is now the ORDINARY one:
		 * an already-open SSE stream silent for 30s is cut by the client's or an
		 * intermediary's idle timeout, which reads as the gateway hanging.
		 */
		keepalive(rs)
		return nil
	}
	// The stream's last chunk is queued and NEVER released by arithmetic: whatever
	// the configured tail, the frames that complete the answer wait for the verdict.
	for _, seg := range segs {
		rs.hold.add(seg.Bytes, seg.Content)
	}
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

// keepaliveAfter is how long a clamped stream may go silent before this filter puts a
// comment frame on the wire.
//
// ⚠️⚠️ Not cosmetic, and since 3.10.0 it is LOAD-BEARING rather than a safety net. With
// the bound at the head, EVERY enforced stream goes quiet ~32 content bytes in and stays
// quiet for the whole generation (a coding agent runs 30s+); a client reading an
// already-open SSE stream that goes quiet for that long is cut by its own or an
// intermediary's idle timeout — which reads as the gateway hanging, the exact failure
// the non-completion escape hatch exists to prevent elsewhere. An SSE comment resets
// every read timer and no client parses it. Before this release the silent case was the
// clamped corner; now it is the happy path, so holdChunk ticks this on every chunk.
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
	/*
	 * ⚠️ AND AN `allow` RELEASES NOTHING (3.10.0). This is where the old design
	 * emptied the queue down to the tail the moment the request half came back clean
	 * — "the head budget stopped applying the moment the request was judged" — which
	 * is precisely the coupling that made response exposure a function of request
	 * latency. The response half has its own judgement and it has not happened yet.
	 * A clamp is handled where the chunks are (holdChunk), because there is nothing
	 * to release here in either direction.
	 */
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
		// ⚠️ Nothing said, or nothing READABLE — and since 3.6.1 the frame count is
		// what separates them, not SawBytes alone. A WELL-FORMED stream that carried
		// no content is the model genuinely saying nothing: a judgeable (vacuous)
		// reply with nothing to refuse, recorded fire-and-forget so the step keeps
		// its response half. Only bytes the decoder recognised NOTHING of are the
		// hole — a reply this plugin cannot judge, which under fail-closed must not
		// go through: "could not look" is not "found nothing" (degraded-mode.md says
		// it is the same situation as an outage, at a different size).
		if sp.SawBytes() {
			if sp.RecognizedFrames() > 0 {
				report(cfg, responseEventCanonical(rs.derive, canonicalOf(rs, out, sp.Timing())))
				bump(cntEmptyReply, 1)
				rs.finishAllow()
				return
			}
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
	err = cfg.client.post(cfg.evaluatePath, ogrHeaders(cfg), payload, cfg.timeoutMs,
		func(status int, respBody []byte) {
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
				if c := v.Continuation(); c != nil {
					rs.finishBlockedSoft(c)
					return
				}
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
		})
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

/*
 * finishBlockedSoft ends a refused stream on a NORMAL completion carrying the notice,
 * so an agent loop reads a finished turn instead of a terminal content filter.
 *
 * ⚠️⚠️ **ONLY WHEN NOTHING WAS RELEASED, and the asymmetry is deliberate.** While we
 * still own every byte, the caller has seen nothing and a complete, honest reply can
 * be delivered in its place. Once bytes are out, the head is on the caller's screen
 * and the tail is being DROPPED: ending that on `stop` would tell the harness the
 * answer completed normally when we truncated it — the one thing a refusal must never
 * claim. So a released stream keeps the hard retraction.
 *
 * ⚠️ The tail hold is what makes this cover the case that matters: argument
 * completions and finish frames are never released, so a refused TOOL CALL is always
 * in the still-own-every-byte branch.
 */
func (rs *reqState) finishBlockedSoft(c *continuation) {
	notice := c.Notice
	if rs.hold != nil && !rs.hold.mayEndSoftly() {
		/*
		 * ⚠️⚠️ Tool-call bytes are already out, so the client may hold a partial call
		 * — and harnesses act on `tool_calls` being non-empty, not on the finish
		 * reason. Ending softly here would invite it to run a call with truncated
		 * arguments. The hard retraction is the only safe ending.
		 */
		logConditionf("tail.softdenied",
			"[OGR-TAIL] tool-call bytes already released — retracting hard instead")
		rs.finishBlocked(notice)
		return
	}
	bump(cntStreamStopped, 1)
	sse := true
	released := false
	if rs.hold != nil {
		sse = rs.hold.sse
		released = rs.hold.sawRelease()
		rs.hold.drop()
	}
	/*
	 * Two shapes, decided by whether the caller has seen anything.
	 *
	 *   - nothing out: we still own every byte, so a complete, self-contained reply
	 *     goes in place of the answer.
	 *   - prose out, no calls: the head is on the caller's screen and cannot be
	 *     un-delivered, so the notice is appended as one more delta and the stream
	 *     completes normally. That is not a completion we are faking — the turn IS
	 *     over, the refused actions are gone, and the notice is what stops the
	 *     truncation being silent.
	 */
	var reply string
	switch {
	case sse && c.Style == contDropCalls:
		/*
		 * ⚠️ THE ONE SHAPE THAT KEEPS A STREAMED LOOP RUNNING. Every call frame is
		 * still in our hands (that is what `mayEndSoftly` just established), so the
		 * calls the policy ALLOWED can be re-emitted while the refused ones simply
		 * never appear. Whether prose already went out does not matter here: these
		 * are new frames either way.
		 */
		if next, ok := rs.survivorFrames(c); ok {
			reply = next
			break
		}
		// This protocol cannot express it mid-stream, or the ordinals did not line
		// up with what we reassembled. The loop still survives; the survivors do not.
		if released {
			reply = rs.proto.RetractSoft(rs.model, notice)
		} else {
			reply = rs.proto.SoftRefuseStream(rs.model, notice)
		}
	case released:
		reply = rs.proto.RetractSoft(rs.model, notice)
	case sse:
		reply = rs.proto.SoftRefuseStream(rs.model, notice)
	default:
		reply = rs.proto.SoftRefuse(rs.model, notice)
	}
	if err := proxywasm.InjectEncodedDataToFilterChain([]byte(reply), true); err != nil {
		proxywasm.LogErrorf("[OGR-TAIL] soft refusal inject failed: %v", err)
	}
}

/*
 * survivorFrames renders the calls that survived the refusal, for a stream.
 *
 * ⚠️ ALL OR NOTHING on the ordinals. An ordinal outside the reassembled list means the
 * directive and what we parsed disagree about this reply, and the caller then drops
 * the tail whole. Emitting the calls we happen to recognise would risk re-emitting a
 * REFUSED one under a notice saying it was refused.
 */
func (rs *reqState) survivorFrames(c *continuation) (string, bool) {
	if rs.sp == nil {
		return "", false
	}
	dropped := c.DroppedOrdinals()
	if len(dropped) == 0 {
		return "", false
	}
	actions := rs.sp.Result().Actions
	drop := make(map[int]bool, len(dropped))
	for _, n := range dropped {
		if n >= len(actions) {
			return "", false
		}
		drop[n] = true
	}
	survivors := make([]protocol.Action, 0, len(actions))
	for i, a := range actions {
		if !drop[i] {
			survivors = append(survivors, a)
		}
	}
	next, ok := rs.proto.DropCallsStream(rs.model, survivors, c.Notice)
	if !ok {
		return "", false
	}
	logInfof("[OGR-TAIL] dropped %d refused call(s), re-emitted %d — the loop continues",
		len(dropped), len(survivors))
	return next, true
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
