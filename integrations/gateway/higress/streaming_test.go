package main

import (
	"strings"
	"testing"
	"time"

	"github.com/openguardrails/higress/protocol"
	"github.com/tidwall/gjson"
)

// The processor is a thin shell now — the SSE reading itself is each protocol's, and is
// tested there. What has to hold HERE is the part the gateway depends on: chunks flow
// through unchanged when there is nothing to restore, a non-streamed reply is read
// without buffering it, and an empty result is distinguishable from an unread one.

func chatProto(t *testing.T) protocol.Protocol {
	t.Helper()
	p := protocol.ByName("openai.chat")
	if p == nil {
		t.Fatal("openai.chat is not registered")
	}
	return p
}

func chunk(content string) string {
	return `data: {"choices":[{"index":0,"delta":{"content":"` + content + `"}}]}` + "\n\n"
}

func TestStreamRestoresAndReassembles(t *testing.T) {
	sp := newStreamProcessor(chatProto(t), map[string]string{"${OGR_EMAIL_1}": "ada@example.com"}, true, time.Time{}, false)

	var out strings.Builder
	for _, c := range []string{chunk("mail "), chunk("${OGR_EMAIL_1}"), chunk(" now")} {
		out.Write(sp.ProcessChunk([]byte(c), false))
	}
	out.Write(sp.ProcessChunk([]byte("data: [DONE]\n\n"), true))

	if !strings.Contains(out.String(), "ada@example.com") {
		t.Fatalf("the caller never got its own data back:\n%s", out.String())
	}
	// ⚠️ What we REPORT keeps the placeholder: detecting on the restored text would
	// find the very value we removed and block our own restoration.
	if got := sp.Result().Text; got != "mail ${OGR_EMAIL_1} now" {
		t.Fatalf("reassembled = %q", got)
	}
}

func TestEmptyMappingIsPassthrough(t *testing.T) {
	sp := newStreamProcessor(chatProto(t), nil, true, time.Time{}, false)
	in := chunk("hello")
	if got := string(sp.ProcessChunk([]byte(in), true)); got != in {
		t.Fatalf("passthrough altered the stream:\n%q\n%q", in, got)
	}
}

func TestANonStreamedReplyIsReportedWithoutBuffering(t *testing.T) {
	// Observe mode never calls BufferResponseBody, so the whole reply arrives here in
	// chunks and must still be readable at the end.
	sp := newStreamProcessor(chatProto(t), nil, false, time.Time{}, false)
	body := `{"choices":[{"message":{"role":"assistant","content":"the answer",` +
		`"tool_calls":[{"id":"c1","function":{"name":"shell","arguments":"{}"}}]}}]}`
	for i := 0; i < len(body); i += 7 {
		end := i + 7
		if end > len(body) {
			end = len(body)
		}
		part := body[i:end]
		if got := string(sp.ProcessChunk([]byte(part), end == len(body))); got != part {
			t.Fatalf("a non-streamed reply must pass through untouched: %q", got)
		}
	}
	out := sp.Result()
	if out.Text != "the answer" {
		t.Fatalf("content = %q", out.Text)
	}
	if len(out.Actions) != 1 || out.Actions[0].Name != "shell" {
		t.Fatalf("tool calls = %+v", out.Actions)
	}
}

func TestTheAccumulatedCopyIsBounded(t *testing.T) {
	sp := newStreamProcessor(chatProto(t), nil, false, time.Time{}, false)
	huge := strings.Repeat("x", maxRawAccum+4096)
	sp.ProcessChunk([]byte(huge), true)
	if sp.raw.Len() > maxRawAccum+len(huge) {
		t.Fatalf("accumulated %d bytes", sp.raw.Len())
	}
	// Delivery is unaffected either way — the cap bounds what we KEEP, not what the
	// caller receives.
	if sp.Bytes() != len(huge) {
		t.Fatalf("byte count = %d, want %d", sp.Bytes(), len(huge))
	}
}

func TestAnUnreadStreamIsDistinguishableFromASilentOne(t *testing.T) {
	// An empty Result means one of two opposite things. `SawBytes` is what separates
	// them, and the difference decides whether the plugin reports a hole.
	silent := newStreamProcessor(chatProto(t), nil, true, time.Time{}, false)
	if silent.SawBytes() {
		t.Error("a processor that received nothing claims it saw bytes")
	}
	unread := newStreamProcessor(chatProto(t), nil, true, time.Time{}, false)
	unread.ProcessChunk([]byte("event: something_else\ndata: {\"type\":\"nope\"}\n\n"), true)
	if !unread.Result().Empty() {
		t.Error("an unrecognised frame produced output")
	}
	if !unread.SawBytes() {
		t.Error("bytes arrived and were not counted, so the hole would be reported as silence")
	}
}

func TestStreamedToolCallsAreReassembled(t *testing.T) {
	sp := newStreamProcessor(chatProto(t), nil, true, time.Time{}, false)
	for _, c := range []string{
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"send","arguments":"{\"to\":"}}]}}]}` + "\n\n",
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a@b.c\"}"}}]}}]}` + "\n\n",
		"data: [DONE]\n\n",
	} {
		sp.ProcessChunk([]byte(c), false)
	}
	sp.ProcessChunk(nil, true)
	out := sp.Result()
	if len(out.Actions) != 1 {
		t.Fatalf("actions = %+v", out.Actions)
	}
	if out.Actions[0].Arguments != `{"to":"a@b.c"}` {
		t.Fatalf("arguments = %q", out.Actions[0].Arguments)
	}
	if !gjson.Valid(out.Actions[0].Arguments) {
		t.Fatal("reassembled arguments are not valid JSON")
	}
}

// The tail-hold releases frames by how much CONTENT sits behind them, so the meter
// must count what the client reads — text — and never the SSE framing around it.
// Counting framing would over-count and release the true tail early.
func TestContentBytesCountsContentNotFraming(t *testing.T) {
	sp := newStreamProcessor(chatProto(t), nil, true, time.Time{}, false)
	if sp.ContentBytes() != 0 {
		t.Fatalf("content before any chunk = %d", sp.ContentBytes())
	}
	sp.ProcessChunk([]byte(chunk("hello")), false)
	if got := sp.ContentBytes(); got != len("hello") {
		t.Fatalf("ContentBytes = %d, want %d (framing must not count)", got, len("hello"))
	}
	sp.ProcessChunk([]byte(chunk(" world")), false)
	if got := sp.ContentBytes(); got != len("hello world") {
		t.Fatalf("ContentBytes = %d, want %d", got, len("hello world"))
	}
	// Tool-call arguments are client-visible content too — they are exactly the
	// bytes a harness acts on.
	sp.ProcessChunk([]byte(
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"sh","arguments":"{\"a\":1}"}}]}}]}`+"\n\n"),
		false)
	if got := sp.ContentBytes(); got != len("hello world")+len(`{"a":1}`) {
		t.Fatalf("ContentBytes = %d, want arguments counted", got)
	}
}

func TestTimingStartsAtTheRequestRelease(t *testing.T) {
	// TTFT is first-chunk minus REQUEST RELEASE. The processor only exists once the
	// first chunk is already arriving, so measuring from its own construction would
	// read every TTFT as ~0 — the release time is threaded in from the request phase.
	release := time.Now().Add(-2 * time.Second)
	sp := newStreamProcessor(chatProto(t), nil, true, release, false)
	sp.ProcessChunk([]byte(chunk("hi")), false)
	sp.ProcessChunk([]byte("data: [DONE]\n\n"), true)

	tm := sp.Timing()
	if tm.StartedAt != release.UTC().Format("2006-01-02T15:04:05.999999999Z07:00") {
		t.Fatalf("started_at = %q, want the release time", tm.StartedAt)
	}
	started, _ := time.Parse(time.RFC3339Nano, tm.StartedAt)
	first, err := time.Parse(time.RFC3339Nano, tm.FirstTokenAt)
	if err != nil || first.Sub(started) < time.Second {
		t.Fatalf("ttft collapsed: started=%s first=%s", tm.StartedAt, tm.FirstTokenAt)
	}
}

func TestSuppressionIsWiredThroughToTheDecoder(t *testing.T) {
	// The injectedUsage flag must actually reach the decoder, or the client parses
	// a frame it never asked for while every test on the decoder itself passes.
	sp := newStreamProcessor(chatProto(t), nil, true, time.Time{}, true)
	out := string(sp.ProcessChunk([]byte(
		`data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}`+"\n\n"+
			"data: [DONE]\n\n"), true))
	if strings.Contains(out, "prompt_tokens") {
		t.Fatalf("the synthetic usage frame reached the client: %q", out)
	}
	u := sp.Result().Usage
	if u == nil || u.InputTokens != 9 || u.OutputTokens != 4 {
		t.Fatalf("usage not captured: %+v", u)
	}
}
