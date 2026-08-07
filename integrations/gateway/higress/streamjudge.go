package main

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm"
	"github.com/tidwall/gjson"
)

// Judging the model's answer WHILE it streams.
//
// The buffered path can hold a reply, judge it and refuse it, because nothing
// has left the gateway yet. A STREAM has already started: the first token is on
// the wire before there is anything to judge, and holding the stream until the
// answer is complete would trade away the only thing streaming buys — the first
// token — to reach a guarantee the medium cannot give anyway.
//
// So a stream is judged AS IT GROWS, and the exposure is BOUNDED rather than
// removed:
//
//   - chunks pass through untouched, so TTFT is exactly what it was;
//   - every `stream_judge_chars` new characters, the answer SO FAR goes to the
//     PDP, one call in flight at a time;
//   - a verdict that blocks stops the REST of the answer and appends a refusal
//     frame, so the client's own renderer shows why it stopped.
//
// ⚠️ What the user has already read cannot be taken back. That is a property of
// streaming, not of this design: the alternative is to buffer the whole reply,
// which is what `stream: false` already does and what a deployment that cannot
// accept ANY exposure should require. What this buys is that the rest of the
// answer — usually most of it — never arrives, and that the console learns about
// it during the turn rather than after it.
//
// ⚠️ Interim judgments are EPHEMERAL (`ogr-partial: 1`). They are ONE event
// judged repeatedly as it grows, not several events: without the flag a single
// answer lands in the console as five fragments, every finding's occurrence
// count rises with the length of the reply, and session risk accumulates once
// per window. The answer is reported ONCE, whole, at end of stream, by the
// path that already did it.

const (
	// New characters between judgments. Sized against the content judge's own
	// latency (150-250ms on the 14B): smaller windows do not detect sooner,
	// they only queue more calls behind the one in flight.
	defaultStreamJudgeChars = 120
	// A cap per stream, so a very long answer cannot turn into an unbounded
	// number of PDP calls. Past it the answer still gets reported and judged
	// whole at end of stream — it just stops being interruptible.
	defaultStreamJudgeMax = 8
)

// streamGuard is the per-response state of streaming judgment.
type streamGuard struct {
	// The stream's model_output event id, held stable across judgments so the
	// PDP sees one growing event rather than a series of unrelated ones.
	eventID string

	judgedAt int  // rune count of the content at the last dispatch
	inFlight bool // one judgment at a time; the next window waits
	calls    int

	cut       bool   // a verdict said this answer must not continue
	reason    string // what to tell the caller
	announced bool   // the refusal frame has been written
}

// dueForJudgment reports whether the answer has grown enough to be worth
// another call. Pure, so the windowing is testable without a gateway.
func (sg *streamGuard) dueForJudgment(runes, window, max int) bool {
	if sg == nil || sg.cut || sg.inFlight || sg.calls >= max {
		return false
	}
	return runes-sg.judgedAt >= window
}

// tail is what the client gets in place of the rest of the answer: the reason,
// a content_filter finish, and [DONE]. Written ONCE — every later chunk of the
// upstream's reply is swallowed.
func (sg *streamGuard) tail(model string) []byte {
	if sg.announced {
		return nil
	}
	sg.announced = true
	return []byte(refusalStream(model, sg.reason))
}

// judgeStream puts the answer so far to the PDP and does not wait for it. The
// callback only sets state: the bytes are written by the streaming hook, which
// is the one place this plugin is allowed to produce output.
func judgeStream(cfg Config, rs *reqState, sg *streamGuard, content string, runes int) {
	events := deriveResponse(rs.derive, rs.session, content, nil, rs.messages)
	if len(events) == 0 {
		return
	}
	judged := events[0]
	// ⚠️ One id for every window AND for the final report. The PDP dedupes on
	// it, so a stream that was judged five times is still one answer.
	if sg.eventID == "" {
		sg.eventID = judged.EventID
	}
	judged.EventID = sg.eventID

	payload, err := json.Marshal(judged)
	if err != nil {
		return
	}
	sg.inFlight = true
	sg.calls++
	sg.judgedAt = runes

	err = cfg.client.Post(pathEvaluate, partialHeaders(cfg), payload,
		func(status int, _ http.Header, body []byte) {
			sg.inFlight = false
			if status != 200 {
				// Fail-open on the stream: the answer is still reported and
				// judged whole at end of stream. Say so, the way the request
				// path does — an unreachable PDP must never read as "clean".
				proxywasm.LogWarnf("[OGR-STREAM] partial evaluate status=%d (0 = timeout), stream continues UNCHECKED", status)
				bump(cntUnchecked, 1)
				return
			}
			bump(cntEvaluated, 1)
			v := gjson.ParseBytes(body)
			decision := v.Get("decision").String()
			// One line per window, bounded by `stream_judge_max`. Without it a
			// deployment cannot tell "the stream was judged and it was fine" from
			// "the stream was never judged", which are the two states this whole
			// mechanism exists to distinguish.
			proxywasm.LogWarnf("[OGR-STREAM] judged %s chars: decision=%s findings=%d",
				strconv.Itoa(sg.judgedAt), decision, len(v.Get("findings").Array()))
			if !stopsRequest(decision) {
				return
			}
			sg.cut = true
			sg.reason = refusalReason(v)
			proxywasm.LogWarnf("[OGR-STREAM] decision=%s after %s chars — cutting the stream, session=%s",
				decision, strconv.Itoa(sg.judgedAt), rs.session.ID)
		}, cfg.timeoutMs)
	if err != nil {
		sg.inFlight = false
		proxywasm.LogErrorf("[OGR-STREAM] partial evaluate dispatch failed: %v", err)
	}
}

// partialHeaders marks a judgment as INTERIM: evaluate it, answer with a
// verdict, record nothing. See the note at the top of this file.
func partialHeaders(cfg Config) [][2]string {
	return append(ogrHeaders(cfg), [2]string{"ogr-partial", "1"})
}
