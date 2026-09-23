package main

import (
	"strings"
	"testing"
	"time"

	"github.com/openguardrails/higress/protocol"
)

// The prose release (3.15.0) forwards text and reasoning as they are produced and
// holds from the first tool-call byte and the ending. The property under test is the
// one a client depends on: HOWEVER the frames fall, no tool-call byte and no frame
// that ENDS the reply leaves before the verdict — and nothing that is prose waits for
// it. Real streams, all three protocols, through the real processor and the real hold.

// runProse feeds frames (one per chunk, the last one flagged isLast) and returns what
// was released before the verdict and what is still held.
func runProse(t *testing.T, proto string, frames []string) (released, held string) {
	t.Helper()
	p := protocol.ByName(proto)
	if p == nil {
		t.Fatalf("%s is not registered", proto)
	}
	sp := newStreamProcessor(p, nil, true, time.Time{}, false)
	h := proseHold(true, 0)
	var out strings.Builder
	for i, f := range frames {
		last := i == len(frames)-1
		for _, seg := range sp.ProcessChunkSegments([]byte(f), last) {
			if last {
				h.add(seg.Bytes, seg.Content, true)
				continue
			}
			for _, r := range h.push(seg.Bytes, seg.Content, seg.Hold) {
				out.Write(r)
			}
		}
	}
	return out.String(), string(h.held())
}

func TestProseStreamsAndTheEndingWaits(t *testing.T) {
	long := strings.Repeat("字", 400) // far past any head budget
	frames := []string{
		`data: {"choices":[{"index":0,"delta":{"role":"assistant"}}]}` + "\n\n",
		`data: {"choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}` + "\n\n",
		`data: {"choices":[{"index":0,"delta":{"content":"` + long + `"}}]}` + "\n\n",
		`data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}` + "\n\n",
		"data: [DONE]\n\n",
	}
	released, held := runProse(t, "openai.chat", frames)
	if !strings.Contains(released, "thinking") || !strings.Contains(released, long) {
		t.Fatalf("prose or reasoning waited for the verdict:\nreleased=%q", released)
	}
	if strings.Contains(released, "finish_reason") || strings.Contains(released, "[DONE]") {
		t.Fatalf("the ENDING left before the verdict — a client reads the turn as over:\n%q", released)
	}
	if !strings.Contains(held, `"finish_reason":"stop"`) || !strings.Contains(held, "[DONE]") {
		t.Fatalf("held = %q", held)
	}
}

// ⚠️ The case the old tail comment took for granted: the terminal frames arrive in a
// NON-last chunk and the isLast chunk is empty (Envoy's end_stream often carries no
// data). A release rule without a budget must still hold them.
func TestTheEndingIsHeldEvenWhenTheLastChunkIsEmpty(t *testing.T) {
	frames := []string{
		`data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}` + "\n\n",
		`data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}` + "\n\n",
		"data: [DONE]\n\n",
		"",
	}
	released, held := runProse(t, "openai.chat", frames)
	if strings.Contains(released, "finish_reason") || strings.Contains(released, "[DONE]") {
		t.Fatalf("the ending escaped ahead of an empty last chunk:\n%q", released)
	}
	if !strings.Contains(held, "[DONE]") {
		t.Fatalf("held = %q", held)
	}
}

func TestNoToolCallByteLeavesBeforeTheVerdict(t *testing.T) {
	frames := []string{
		`data: {"choices":[{"index":0,"delta":{"content":"let me send it"}}]}` + "\n\n",
		`data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"send","arguments":"{\"to\":"}}]}}]}` + "\n\n",
		// Prose AFTER a call is held too: the hold is monotonic.
		`data: {"choices":[{"index":0,"delta":{"content":"more"}}]}` + "\n\n",
		`data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a@b.c\"}"}}]}}]}` + "\n\n",
		`data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}` + "\n\n",
		"data: [DONE]\n\n",
	}
	released, held := runProse(t, "openai.chat", frames)
	if !strings.Contains(released, "let me send it") {
		t.Fatalf("the prose before the call waited: %q", released)
	}
	for _, leak := range []string{"tool_calls", `"name":"send"`, "more"} {
		if strings.Contains(released, leak) {
			t.Fatalf("%q left before the verdict:\n%q", leak, released)
		}
	}
	if !strings.Contains(held, `"name":"send"`) {
		t.Fatalf("held = %q", held)
	}
}

func TestAnthropicProseStreamsAndToolUseAndStopWait(t *testing.T) {
	ev := func(typ, data string) string { return "event: " + typ + "\ndata: " + data + "\n\n" }
	frames := []string{
		ev("message_start", `{"type":"message_start","message":{"usage":{"input_tokens":3}}}`),
		ev("content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}`),
		ev("content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}`),
		ev("content_block_start", `{"type":"content_block_start","index":1,"content_block":{"type":"text"}}`),
		ev("content_block_delta", `{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"answer"}}`),
		ev("content_block_stop", `{"type":"content_block_stop","index":1}`),
		ev("content_block_start", `{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"t1","name":"rm"}}`),
		ev("content_block_delta", `{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{}"}}`),
		ev("message_delta", `{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}`),
		ev("message_stop", `{"type":"message_stop"}`),
	}
	released, held := runProse(t, "anthropic.messages", frames)
	if !strings.Contains(released, "hmm") || !strings.Contains(released, "answer") {
		t.Fatalf("thinking or text waited: %q", released)
	}
	for _, leak := range []string{"tool_use", "message_delta", "message_stop"} {
		if strings.Contains(released, leak) {
			t.Fatalf("%q left before the verdict:\n%q", leak, released)
		}
	}
	if !strings.Contains(held, `"name":"rm"`) || !strings.Contains(held, "message_stop") {
		t.Fatalf("held = %q", held)
	}
}

func TestResponsesProseStreamsAndCompletedWaits(t *testing.T) {
	ev := func(typ, data string) string { return "event: " + typ + "\ndata: " + data + "\n\n" }
	frames := []string{
		ev("response.output_item.added", `{"type":"response.output_item.added","output_index":0,"item":{"type":"message"}}`),
		ev("response.output_text.delta", `{"type":"response.output_text.delta","output_index":0,"delta":"hello"}`),
		// A per-item .done is NOT the ending — the stream may go on to a call.
		ev("response.output_item.done", `{"type":"response.output_item.done","output_index":0,"item":{"type":"message"}}`),
		ev("response.completed", `{"type":"response.completed","response":{"output":[]}}`),
	}
	released, held := runProse(t, "openai.responses", frames)
	if !strings.Contains(released, "hello") || !strings.Contains(released, "response.output_item.done") {
		t.Fatalf("prose (or a per-item .done) waited: %q", released)
	}
	if strings.Contains(released, "response.completed") {
		t.Fatalf("response.completed left before the verdict:\n%q", released)
	}
	if !strings.Contains(held, "response.completed") {
		t.Fatalf("held = %q", held)
	}
}

// ⚠️ A decoder that cannot say whether it ended reads as ENDED — the side that holds.
func TestAnUnknownEndingHolds(t *testing.T) {
	s := protocol.NewScanner(silentDecoder{})
	segs := s.ChunkSegments([]byte("data: x\n\n"), false)
	if len(segs) != 1 || !segs[0].Hold {
		t.Fatalf("a decoder with no EndWatcher released: %+v", segs)
	}
}

type silentDecoder struct{}

func (silentDecoder) Line(line string, isLast bool) string { return line }
func (silentDecoder) Flush() string                        { return "" }
func (silentDecoder) Output() protocol.Output              { return protocol.Output{} }

// A non-SSE reply has no frames worth releasing, prose or not.
func TestProseHoldsANonSSEReplyWhole(t *testing.T) {
	h := proseHold(false, 0)
	if got := h.push([]byte(`{"choices":[`), 10, false); got != nil {
		t.Fatalf("released %q of a JSON body", got)
	}
}

func TestTheHoldIsBounded(t *testing.T) {
	h := proseHold(true, 10)
	h.push([]byte("prose"), 5, false) // released: not counted
	if h.overflowed() {
		t.Fatal("released bytes counted against the hold")
	}
	h.push([]byte("call-bytes"), 15, true)
	if h.overflowed() {
		t.Fatal("10 held bytes against a 10-byte bound is not over it")
	}
	h.push([]byte("x"), 16, true)
	if !h.overflowed() {
		t.Fatal("11 held bytes against a 10-byte bound did not overflow")
	}
	// Overflow under open: everything held goes out, and so does everything after.
	h.settled, h.bypass = true, true
	if got := h.push(nil, 0, false); len(got) != 2 {
		t.Fatalf("bypass released %d segments, want the 2 held", len(got))
	}
	if got := h.push([]byte("later"), 20, true); len(got) != 1 {
		t.Fatal("bypass kept holding")
	}
	if h.overflowed() {
		t.Fatal("a settled hold reported overflow twice")
	}
}

func TestZeroMeansNoBound(t *testing.T) {
	h := proseHold(true, 0)
	h.push([]byte(strings.Repeat("x", 1<<20)), 1, true)
	if h.overflowed() {
		t.Fatal("stream_hold_max_bytes 0 bounded the hold")
	}
}

func proseHold(sse bool, max int) *tailHold {
	h := newTailHold(-1, sse)
	h.max = max
	return h
}

// ⚠️ 3.15.1: the budget bounds PROSE only. A tool-call segment is held even when it
// would fit inside a budget — under 3.10.0 a large N let call bytes out.
func TestAToolCallIsHeldWhateverTheBudget(t *testing.T) {
	h := newTailHold(1000, true)
	if got := h.push([]byte("prose"), 5, false); len(got) != 1 {
		t.Fatalf("prose inside the budget waited: %q", got)
	}
	if got := h.push([]byte("call"), 9, true); got != nil {
		t.Fatalf("a tool-call segment left inside a 1000-byte budget: %q", got)
	}
	if h.releasedCalls {
		t.Fatal("releasedCalls set although no call byte left")
	}
}

func TestAZeroBudgetStillReleasesNothingUnderTheOneKnob(t *testing.T) {
	h := newTailHold(0, true)
	if got := h.push([]byte("prose"), 5, false); got != nil {
		t.Fatalf("0 released %q", got)
	}
}
