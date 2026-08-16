package main

import (
	"bytes"
	"testing"
)

// The tail-hold's release arithmetic is the enforcement mechanism for streams, so
// the property under test is the security one: HOWEVER the chunks fall, at least
// `tail` bytes of client-visible content — and always the final chunk — stay
// withheld until the verdict. The wasm plumbing around it (injection, pause) is
// not testable on the host and is deliberately kept out of the queue type.

// seg pushes one chunk whose CONTENT length is given, and returns what was released.
type tailFixture struct {
	h   *tailHold
	cum int
}

func (f *tailFixture) push(t *testing.T, frame string, contentLen int) []byte {
	t.Helper()
	f.cum += contentLen
	var out []byte
	for _, seg := range f.h.push([]byte(frame), f.cum) {
		out = append(out, seg...)
	}
	return out
}

func TestTheTailStaysWithheldUntilTheVerdict(t *testing.T) {
	f := &tailFixture{h: newTailHold(10, true)}

	// 6 content bytes: nothing may be released (10 withheld required, only 6 exist).
	if got := f.push(t, "frame-A", 6); got != nil {
		t.Fatalf("released %q with only 6 content bytes seen", got)
	}
	// +6 = 12 total. Content AFTER frame-A is 6 < 10: A stays held.
	if got := f.push(t, "frame-B", 6); got != nil {
		t.Fatalf("released %q while only 6 content bytes sat behind the oldest frame", got)
	}
	// +8 = 20 total. Behind A: 14 ≥ 10 → A releases. Behind B: 8 < 10 → B stays.
	if got := f.push(t, "frame-C", 8); string(got) != "frame-A" {
		t.Fatalf("released %q, want exactly frame-A", got)
	}
	// The held remainder is B+C, in order, and releasing was recorded.
	if got := f.h.held(); string(got) != "frame-Bframe-C" {
		t.Fatalf("held = %q", got)
	}
	if !f.h.sawRelease() {
		t.Error("a released byte was not recorded — block would render a refusal over a stream the caller already read")
	}
}

// ⚠️ Even `stream_tail_chars: 0` must not let a stream COMPLETE before the verdict:
// the final chunk carries the frames a client acts on (tool-call completions,
// finish_reason, [DONE]) and is queued via add(), which never releases.
func TestTheFinalChunkIsNeverReleasedByArithmetic(t *testing.T) {
	h := newTailHold(0, true)
	if got := h.push([]byte("body"), 4); len(got) != 1 || string(got[0]) != "body" {
		t.Fatalf("tail=0 should release earlier chunks immediately, got %q", got)
	}
	h.add([]byte("data: [DONE]\n\n"), 4)
	if got := h.held(); string(got) != "data: [DONE]\n\n" {
		t.Fatalf("the terminal frame escaped the hold: held = %q", got)
	}
}

// A response that is not a real event stream degenerates to buffering — partial
// JSON is useless to a client, and holding everything is the spec's own tail = ∞
// limit case. A block then still owns every byte: a true refusal, not a retraction.
func TestANonSSEResponseIsHeldWhole(t *testing.T) {
	h := newTailHold(10, false)
	if got := h.push([]byte(`{"choices":[...`), 1000); got != nil {
		t.Fatalf("a non-SSE body leaked ahead of the verdict: %q", got)
	}
	if h.sawRelease() {
		t.Error("sawRelease on a fully held reply — a block would retract instead of refusing")
	}
	if string(h.held()) != `{"choices":[...` {
		t.Fatalf("held = %q", h.held())
	}
}

// Frames with no content (role deltas, pings, comment heartbeats) must not jam the
// queue: once enough content arrives behind them they flow, in arrival order.
func TestContentlessFramesAreReleasedByTheContentBehindThem(t *testing.T) {
	f := &tailFixture{h: newTailHold(5, true)}
	f.push(t, ": ping\n\n", 0)
	got := f.push(t, "words", 20)
	if !bytes.HasPrefix(got, []byte(": ping\n\n")) {
		t.Fatalf("the contentless frame did not release first: %q", got)
	}
}

func TestDropDiscardsTheTail(t *testing.T) {
	h := newTailHold(100, true)
	h.add([]byte("secret tail"), 11)
	h.drop()
	if got := h.held(); len(got) != 0 {
		t.Fatalf("dropped tail still held: %q", got)
	}
}

/*
 * THE SPECULATIVE HEAD (3.1.0). The queue half stays pure, so the arithmetic that
 * decides how much of an unjudged answer reaches the caller is testable without a
 * gateway — which matters more here than anywhere else in this file, because the
 * quantity under test IS the security cost of the feature.
 */
func TestPushHeadStopsAtBudget(t *testing.T) {
	h := newTailHold(0, true) // no tail, so only the head budget bounds anything
	released := 0
	var out [][]byte
	cum := 0
	for i := 0; i < 10; i++ {
		chunk := []byte("0123456789") // 10 content bytes per chunk
		cum += len(chunk)
		out = append(out, h.pushHead(chunk, cum, 25, &released)...)
	}
	total := 0
	for _, seg := range out {
		total += len(seg)
	}
	// Release granularity is the CHUNK, so the bound is "stops once past the budget",
	// never "emits exactly the budget" — the same floor/ceiling rule the tail follows.
	if released < 25 || released > 35 {
		t.Fatalf("released %d bytes, want the first chunk past a 25-byte budget", released)
	}
	if total != released {
		t.Fatalf("counter %d disagrees with the bytes emitted %d", released, total)
	}
}

func TestShortAnswerReleasesNothingSoARefusalStaysClean(t *testing.T) {
	/*
	 * ⚠️ THE PROPERTY THE WHOLE DESIGN LEANS ON. An answer shorter than the tail
	 * releases NOTHING even with a head budget, so `sawRelease()` is false and
	 * `finishBlocked` renders a CLEAN REFUSAL rather than a retraction. The case that
	 * matters most — unsafe question, model refuses on its own in one sentence — has
	 * to land here by arithmetic, with no special case.
	 */
	h := newTailHold(200, true)
	released := 0
	var out [][]byte
	cum := 0
	for _, chunk := range []string{"抱歉，", "我不能", "回答这个问题。"} {
		cum += len(chunk)
		out = append(out, h.pushHead([]byte(chunk), cum, headReleaseBytes, &released)...)
	}
	if len(out) != 0 || released != 0 {
		t.Fatalf("released %d bytes of a %d-byte answer; a refusal must stay whole", released, cum)
	}
	if h.sawRelease() {
		t.Fatal("sawRelease() true ⇒ finishBlocked would RETRACT instead of refusing")
	}
}

func TestReleaseDrainsOnceTheVerdictLifted(t *testing.T) {
	h := newTailHold(10, true)
	released := 0
	cum := 0
	for i := 0; i < 5; i++ {
		cum += 10
		h.pushHead([]byte("0123456789"), cum, 0, &released) // budget 0 = hold everything
	}
	if released != 0 {
		t.Fatalf("a zero head budget released %d bytes", released)
	}
	// The verdict lands: everything except the tail may go.
	got := 0
	for _, seg := range h.release(cum) {
		got += len(seg)
	}
	if got != 40 {
		t.Fatalf("released %d of 50 content bytes, want 40 (10 held as the tail)", got)
	}
}

func TestSpeculativeRequiresEnforceStreamingAndFailOpen(t *testing.T) {
	streaming := &reqState{streaming: true}
	buffered := &reqState{streaming: false}
	open := Config{mode: modeEnforce}
	closed := Config{mode: modeEnforce, failClosed: true}
	observe := Config{mode: modeObserve}

	if !speculative(open, streaming) {
		t.Fatal("enforce + streaming + fail-open must speculate")
	}
	// ⚠️ fail-CLOSED is the safety one: releasing a head puts unjudged bytes on the
	// wire on the happy path, which is the literal thing `closed` forbids.
	if speculative(closed, streaming) {
		t.Fatal("fail-closed must not release an unjudged head")
	}
	if speculative(open, buffered) {
		t.Fatal("a buffered reply has no head to release early")
	}
	if speculative(observe, streaming) {
		t.Fatal("observe holds nothing; there is no latency here to remove")
	}
}
