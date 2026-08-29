package main

import "testing"

// The tail-hold's release arithmetic is the enforcement mechanism for streams, so
// the property under test is the security one: HOWEVER the chunks fall, no more than
// `head` bytes of client-visible content — and never the final chunk — reach the
// caller before the verdict. The wasm plumbing around it (injection, pause) is not
// testable on the host and is deliberately kept out of the queue type.

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

func TestOnlyTheHeadReachesTheCallerBeforeTheVerdict(t *testing.T) {
	f := &tailFixture{h: newTailHold(10, true)}

	// 6 content bytes, still inside a 10-byte budget: this frame may go.
	if got := f.push(t, "frame-A", 6); string(got) != "frame-A" {
		t.Fatalf("released %q, want frame-A inside the budget", got)
	}
	// +6 = 12 > 10. Releasing B would put 12 bytes in front of the caller, so B is
	// held WHOLE — the ceiling never overshoots by a chunk.
	if got := f.push(t, "frame-B", 6); got != nil {
		t.Fatalf("released %q past the 10-byte head budget", got)
	}
	// The budget, once spent, stays spent however much more arrives.
	if got := f.push(t, "frame-C", 8); got != nil {
		t.Fatalf("released %q after the budget was spent", got)
	}
	if got := f.h.held(); string(got) != "frame-Bframe-C" {
		t.Fatalf("held = %q", got)
	}
	if !f.h.sawRelease() {
		t.Error("a released byte was not recorded — block would render a refusal over a stream the caller already read")
	}
}

// ⚠️ Whatever the head budget — including a budget the answer never exhausts — the
// stream must not COMPLETE before the verdict: the final chunk carries the frames a
// client acts on (tool-call completions, finish_reason, [DONE]) and is queued via
// add(), which never releases.
func TestTheFinalChunkIsNeverReleasedByArithmetic(t *testing.T) {
	h := newTailHold(100, true)
	if got := h.push([]byte("body"), 4); len(got) != 1 || string(got[0]) != "body" {
		t.Fatalf("a chunk inside the budget should release immediately, got %q", got)
	}
	h.add([]byte("data: [DONE]\n\n"), 4)
	if got := h.held(); string(got) != "data: [DONE]\n\n" {
		t.Fatalf("the terminal frame escaped the hold: held = %q", got)
	}
}

// ⚠️ `stream_head_release_bytes: 0` is a REAL setting, not a disabled feature: it
// releases nothing at all, so the caller sees an open stream and then the whole
// judged answer — and every block stays a CLEAN refusal.
func TestAZeroBudgetReleasesNothing(t *testing.T) {
	f := &tailFixture{h: newTailHold(0, true)}
	if got := f.push(t, "frame-A", 1); got != nil {
		t.Fatalf("a zero budget released %q", got)
	}
	if f.h.sawRelease() {
		t.Error("sawRelease() true under a zero budget ⇒ a block would retract instead of refusing")
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

// ⚠️ Frames with no content (role deltas, pings, comment heartbeats) carry the
// PRECEDING content total, so they ride out for free while the budget is unspent.
// That is what makes even a small budget look like a live stream rather than a
// stalled connection.
func TestContentlessFramesRideOutFreeWhileTheBudgetIsUnspent(t *testing.T) {
	f := &tailFixture{h: newTailHold(5, true)}
	if got := f.push(t, ": ping\n\n", 0); string(got) != ": ping\n\n" {
		t.Fatalf("a contentless frame was held: %q", got)
	}
	// 20 content bytes blows a 5-byte budget in one chunk — held whole, not trimmed.
	if got := f.push(t, "words", 20); got != nil {
		t.Fatalf("released %q past the budget", got)
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
 * THE HEAD BUDGET (3.10.0). The queue half stays pure, so the arithmetic that decides
 * how much of an unjudged answer reaches the caller is testable without a gateway —
 * which matters more here than anywhere else in this file, because the quantity under
 * test IS the security cost of streaming at all.
 */
func TestTheBudgetIsACeilingAndIsNeverOvershot(t *testing.T) {
	f := &tailFixture{h: newTailHold(25, true)}
	var out []byte
	for i := 0; i < 10; i++ {
		out = append(out, f.push(t, "0123456789", 10)...) // 10 content bytes per chunk
	}
	/*
	 * ⚠️ 20, never 30. The predecessor released the chunk that CROSSED the budget and
	 * documented itself as a floor ("stops once past the budget"); a ceiling holds it.
	 * With the tail gone that overshoot is no longer absorbed by anything — it would
	 * be exposure, straight out.
	 */
	if len(out) != 20 {
		t.Fatalf("released %d bytes against a 25-byte ceiling, want 20", len(out))
	}
}

/*
 * ⚠️⚠️ WHAT 3.10.0 GAVE UP, PINNED HONESTLY. Under `stream_tail_chars` an answer
 * shorter than the tail released NOTHING, so `sawRelease()` stayed false and
 * `finishBlocked` rendered a CLEAN REFUSAL — the "unsafe question, model refuses
 * itself in one sentence" case landed there by arithmetic. A head budget spends
 * itself on the FIRST bytes instead, so that answer now leaks its opening fragment
 * and a block is a retraction. The trade was taken deliberately: the tail's clean
 * refusal was bought by delivering the whole of every LONGER answer, which is the
 * failure that started this. A deployment that wants the old property back sets the
 * budget to 0 — and that is the only way to have it.
 */
func TestACleanRefusalNowRequiresAZeroBudget(t *testing.T) {
	refusal := []string{"抱歉，", "我不能", "回答这个问题。"} // 9 + 9 + 21 = 39 bytes

	f := &tailFixture{h: newTailHold(32, true)}
	for _, chunk := range refusal {
		f.push(t, chunk, len(chunk))
	}
	if !f.h.sawRelease() {
		t.Fatal("at the default budget a short refusal DOES leak its head — if this passes, the trade-off above was undone silently")
	}

	f = &tailFixture{h: newTailHold(0, true)}
	for _, chunk := range refusal {
		if got := f.push(t, chunk, len(chunk)); got != nil {
			t.Fatalf("a zero budget released %q", got)
		}
	}
	if f.h.sawRelease() {
		t.Fatal("sawRelease() true ⇒ finishBlocked would RETRACT instead of refusing")
	}
}

/*
 * ⚠️ THE REQUEST HALF NO LONGER LIFTS ANYTHING (3.10.0). There is deliberately no
 * `release()` on this type any more: the old one drained the queue down to the tail
 * when the deep request verdict allowed, which made RESPONSE exposure a function of
 * REQUEST latency. The pure half of that removal is this: the budget, once spent,
 * stays spent for the life of the stream, and nothing can re-open it.
 */
func TestASpentBudgetStaysSpent(t *testing.T) {
	f := &tailFixture{h: newTailHold(10, true)}
	f.push(t, "aaaaaaaaaa", 10) // exactly the budget
	for i := 0; i < 50; i++ {
		if got := f.push(t, "more", 4); got != nil {
			t.Fatalf("chunk %d released %q after the budget was spent", i, got)
		}
	}
	if n := len(f.h.held()); n != 50*len("more") {
		t.Fatalf("held %d bytes, want every later chunk queued", n)
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

/*
 * ⚠️⚠️ THE CONDITION THAT DECIDES WHETHER A REFUSED STREAM MAY END NORMALLY.
 *
 * Ending on a normal stop is what lets an agent loop survive a refusal — but only
 * while the client cannot have assembled an actionable tool call. Harnesses act on
 * `tool_calls` being non-empty rather than on the finish reason (hermes:
 * `if assistant_message.tool_calls:`), so a soft ending after tool-call bytes went out
 * runs a call with truncated arguments — an action nobody approved, produced by the
 * mechanism meant to refuse one.
 */
func TestAStreamMayEndSoftlyOnlyWhileNoCallBytesAreOut(t *testing.T) {
	// Nothing released at all: we still own every byte.
	h := newTailHold(64, true)
	if !h.mayEndSoftly() {
		t.Error("an untouched stream must be endable softly")
	}

	// Prose released, no calls yet — the reasoning-model shape, and the case the
	// whole continuation exists for.
	h = newTailHold(4, true)
	h.sawCalls = false
	h.push([]byte("aaaa"), 4)
	h.push([]byte("bbbb"), 8)
	h.push([]byte("cccc"), 12)
	if !h.sawRelease() {
		t.Fatal("expected the arithmetic to release something")
	}
	if !h.mayEndSoftly() {
		t.Error("prose out with no calls must still be endable softly")
	}

	// A segment produced once tool-call bytes existed is then RELEASED.
	h = newTailHold(4, true)
	h.sawCalls = true
	h.push([]byte("aaaa"), 4)
	h.push([]byte("bbbb"), 8)
	h.push([]byte("cccc"), 12)
	if h.mayEndSoftly() {
		t.Error("released tool-call bytes must force the hard retraction")
	}
}

/*
 * ⚠️ The per-segment flag is what makes the above correct, and a single whole-hold
 * flag would not be: every refused tool call has call bytes SOMEWHERE by definition,
 * so the question is only ever whether a segment carrying them was RELEASED. Here the
 * calls arrive after the released prose and stay in the queue.
 */
func TestCallBytesStillHeldDoNotForbidASoftEnding(t *testing.T) {
	h := newTailHold(4, true)
	h.sawCalls = false
	h.push([]byte("aaaa"), 4) // prose
	h.push([]byte("bbbb"), 8) // prose — releases the first
	h.sawCalls = true         // the decoder now has a tool call
	h.push([]byte("cccc"), 12)
	h.add([]byte("dddd"), 16)
	if !h.sawRelease() {
		t.Fatal("expected a release")
	}
	if !h.mayEndSoftly() {
		t.Error("call bytes that never left must not forbid a soft ending")
	}
}

/*
 * ⚠️⚠️ THE GRANULARITY IS THE WHOLE FEATURE, and this is the case that proved it.
 * Until the scanner learned to split at frame boundaries, the hold released in whole
 * upstream CHUNKS — and a chunk on this lab is ~16 KB carrying 329 content bytes. So
 * the FIRST chunk already blew any budget worth setting, the ceiling held it whole,
 * and `stream_head_release_bytes: 32` behaved exactly like 0: nothing delivered until
 * the verdict, TTFT unchanged, which is the opposite of why the number was chosen.
 * Measured live before the fix (head=300, a 913-byte answer): 0 bytes delivered until
 * 1731ms, then all 913 at once.
 *
 * The property: a budget SMALLER than one arrival must still be spendable, because
 * the arrival is made of frames and a frame is what the client acts on.
 */
func TestABudgetSmallerThanOneArrivalIsStillSpendable(t *testing.T) {
	f := &tailFixture{h: newTailHold(32, true)}
	// One 16 KB arrival, decomposed into its frames: 9 content bytes each, as a
	// Chinese three-character delta actually arrives.
	var out []byte
	for i := 0; i < 40; i++ {
		out = append(out, f.push(t, "data: {...}\n\n", 9)...)
	}
	// 9·3 = 27 fits; 9·4 = 36 does not. Three frames, and never a fourth.
	if n := len(out) / len("data: {...}\n\n"); n != 3 {
		t.Fatalf("released %d frames against a 32-byte budget over 9-byte frames, want 3", n)
	}
	if !f.h.sawRelease() {
		t.Fatal("nothing released at all — the budget is unspendable again, which is the bug this pins")
	}
}
