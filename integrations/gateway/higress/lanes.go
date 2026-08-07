package main

import (
	"encoding/json"
	"net/http"

	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm"
	"github.com/higress-group/wasm-go/pkg/wrapper"
	"github.com/tidwall/gjson"
)

// TWO LANES FOR A STREAMED ANSWER.
//
// A buffered reply can be judged and refused before anyone sees it. A stream cannot:
// the first token is on the wire before there is anything to judge. This plugin used
// to square that by judging the answer every N characters and cutting on a hit, and
// the pipeline measured exactly that (`docs/STREAMING_GUARDRAIL.md`): at 25% of the
// reply visible, false positives on `mt_harm_correct` are 0.353 against 0.000 on the
// whole reply, all of it the answer that agrees on the surface and corrects
// underneath. Early judgement is a fit prefilter and an unfit blocking criterion.
//
// So the answer is judged ONCE, whole, at end of stream — and what differs between
// the two lanes is only whether the caller was allowed to read it in the meantime:
//
//	buffer  the chunks are withheld, the whole answer is judged, and it is released
//	        or refused. A TRUE block: the caller never saw it.
//	stream  the chunks flow (TTFT unchanged), the whole answer is judged at the end,
//	        and a hit appends `finish_reason: "content_filter"`. A RETRACTION: the
//	        caller may already have read it.
//
// ⚠️ WHICH LANE IS THE RUNTIME'S DECISION, carried on the input verdict as
// `x.ogr.output_mode`. A gateway that picked its own lane would be a second place
// policy lives — and the choice really is policy: an observe-only workspace should
// not pay buffering latency for an outcome it will not enforce, while a deployment
// that can accept no exposure wants the buffered lane always.
//
// ⚠️ BOTH LANES ARE JUDGED. Skipping the final check when the question looked clean
// saves 58% of the calls and was measured and rejected: 46 of 400 real violating
// replies (11.5%) have a question the input side never flags, and those are exactly
// the ones nothing else catches — model drift, hallucinated defamation, an attack
// visible only in the answer.
//
// ⚠️ The whole mechanism rests on `NeedPauseStreamingResponse` + injection. Once the
// response is paused EVERY chunk stops at this filter, so the passthrough lane has to
// inject each chunk itself to keep flowing. That is not a detour around the pause — it
// is what taking ownership of the flow means, and it is why the pause is armed in the
// REQUEST phase, before there is a first chunk to be late for.

// armLanes decides the lane from the input verdict and, in enforce mode, takes
// ownership of the response stream so the end-of-stream judgement has somewhere to
// put its answer.
//
// Called from the input verdict handler — `NeedPauseStreamingResponse` must be set
// before the response phase begins.
func armLanes(ctx wrapper.HttpContext, cfg Config, rs *reqState, v gjson.Result) {
	// The runtime only states a lane on an input judgement, and only a streaming
	// request has lanes to choose between. Absent = the pre-lane behaviour, which is
	// the passthrough one.
	rs.bufferOutput = v.Get("x\\.ogr\\.output_mode").String() == "buffer"
	if cfg.mode != modeEnforce || !rs.streaming {
		return
	}
	rs.laneOwned = true
	ctx.NeedPauseStreamingResponse()
}

// laneChunk is the streaming body callback once the lanes own the flow. It returns
// the bytes the wrapper should write, which is always none — everything reaches the
// caller through injection instead.
func laneChunk(ctx wrapper.HttpContext, cfg Config, rs *reqState, out []byte, isLast bool) []byte {
	if rs.bufferOutput {
		// Withheld. Kept whole so a released answer is byte-identical to what the
		// model produced — re-rendering it from the parsed content would drop the
		// tool_calls, the ids and the usage block the client expects.
		rs.held = append(rs.held, out...)
	} else if len(out) > 0 {
		// Passthrough: on its way immediately, so TTFT is exactly what it was.
		if err := proxywasm.InjectEncodedDataToFilterChain(out, false); err != nil {
			proxywasm.LogErrorf("[OGR-LANE] inject failed: %v", err)
		}
	}
	if !isLast {
		return nil
	}
	judgeFinal(ctx, cfg, rs)
	return nil
}

// judgeFinal puts the COMPLETE answer to the PDP and finishes the response with what
// the verdict says.
//
// ⚠️ Every path through here must end in an injection with `endStream: true`. The
// response is paused; a branch that returns without injecting leaves the caller
// hanging until its own timeout, which is a worse failure than either lane's.
func judgeFinal(ctx wrapper.HttpContext, cfg Config, rs *reqState) {
	sp, _ := ctx.GetContext(ctxStream).(*streamProcessor)
	if sp == nil {
		rs.finish(nil)
		return
	}
	content, calls := sp.Result()
	if content == "" && len(calls) == 0 {
		rs.finish(nil)
		return
	}

	events := deriveResponse(rs.derive, rs.session, content, calls, rs.messages)
	if len(events) == 0 {
		rs.finish(nil)
		return
	}
	judged := events[0]
	reportAsync(ctx, cfg, events[1:])
	mirrorEvents(cfg, []*GuardEvent{judged})

	payload, err := json.Marshal(judged)
	if err != nil {
		rs.finish(nil)
		return
	}
	err = cfg.client.Post(pathEvaluate, ogrHeaders(cfg), payload,
		func(status int, _ http.Header, respBody []byte) {
			if status != 200 {
				// Fail mode decides, exactly as it does on the request side. Note the
				// asymmetry the medium forces: failing CLOSED on the passthrough lane
				// can only retract, because the answer has already been read.
				if cfg.failClosed {
					rs.finishBlocked(failMessage)
					return
				}
				rs.finish(nil)
				return
			}
			bump(cntEvaluated, 1)
			v := gjson.ParseBytes(respBody)
			if stopsRequest(v.Get("decision").String()) {
				rs.finishBlocked(refusalReason(v))
				return
			}
			rs.finish(nil)
		}, cfg.timeoutMs)
	if err != nil {
		proxywasm.LogErrorf("[OGR-LANE] final evaluate dispatch failed: %v", err)
		rs.finish(nil)
	}
}

// finish releases the answer: the withheld bytes on the buffered lane, nothing more
// on the passthrough one (its bytes went out as they arrived).
func (rs *reqState) finish(extra []byte) {
	body := extra
	if rs.bufferOutput {
		body = append(rs.held, extra...)
	}
	if err := proxywasm.InjectEncodedDataToFilterChain(body, true); err != nil {
		proxywasm.LogErrorf("[OGR-LANE] final inject failed: %v", err)
	}
}

// finishBlocked ends a stream the verdict refused.
//
// The two lanes end differently because they can: the buffered one still owns every
// byte, so it substitutes a refusal the caller reads as the answer; the passthrough
// one has already delivered the text and can only append the frame that tells a
// client to take the message back.
func (rs *reqState) finishBlocked(reason string) {
	bump(cntStreamStopped, 1)
	if rs.bufferOutput {
		rs.held = nil
		if err := proxywasm.InjectEncodedDataToFilterChain(
			[]byte(refusalStream(rs.model, reason)), true); err != nil {
			proxywasm.LogErrorf("[OGR-LANE] refusal inject failed: %v", err)
		}
		return
	}
	if err := proxywasm.InjectEncodedDataToFilterChain(
		[]byte(contentFilterFrames(rs.model)), true); err != nil {
		proxywasm.LogErrorf("[OGR-LANE] retraction inject failed: %v", err)
	}
}
