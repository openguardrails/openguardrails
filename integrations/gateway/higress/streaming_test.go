package main

import (
	"strings"
	"testing"

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
	sp := newStreamProcessor(chatProto(t), map[string]string{"${OGR_EMAIL_1}": "ada@example.com"}, true)

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
	sp := newStreamProcessor(chatProto(t), nil, true)
	in := chunk("hello")
	if got := string(sp.ProcessChunk([]byte(in), true)); got != in {
		t.Fatalf("passthrough altered the stream:\n%q\n%q", in, got)
	}
}

func TestANonStreamedReplyIsReportedWithoutBuffering(t *testing.T) {
	// Observe mode never calls BufferResponseBody, so the whole reply arrives here in
	// chunks and must still be readable at the end.
	sp := newStreamProcessor(chatProto(t), nil, false)
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
	sp := newStreamProcessor(chatProto(t), nil, false)
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
	silent := newStreamProcessor(chatProto(t), nil, true)
	if silent.SawBytes() {
		t.Error("a processor that received nothing claims it saw bytes")
	}
	unread := newStreamProcessor(chatProto(t), nil, true)
	unread.ProcessChunk([]byte("event: something_else\ndata: {\"type\":\"nope\"}\n\n"), true)
	if !unread.Result().Empty() {
		t.Error("an unrecognised frame produced output")
	}
	if !unread.SawBytes() {
		t.Error("bytes arrived and were not counted, so the hole would be reported as silence")
	}
}

func TestStreamedToolCallsAreReassembled(t *testing.T) {
	sp := newStreamProcessor(chatProto(t), nil, true)
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
