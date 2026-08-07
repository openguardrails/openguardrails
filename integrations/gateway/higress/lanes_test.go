package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// The two ways a stream can end when the final judgement refuses it. Pure string
// work, so it stays testable without a gateway — the injection plumbing around it is
// not, which is exactly why the shapes it injects are pinned here.

func frames(t *testing.T, sse string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, block := range strings.Split(sse, "\n\n") {
		block = strings.TrimSpace(block)
		if !strings.HasPrefix(block, "data: ") {
			continue
		}
		payload := strings.TrimPrefix(block, "data: ")
		if payload == "[DONE]" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(payload), &m); err != nil {
			t.Fatalf("frame is not JSON: %v\n%s", err, payload)
		}
		out = append(out, m)
	}
	return out
}

func finishReason(t *testing.T, frame map[string]any) string {
	t.Helper()
	choices, _ := frame["choices"].([]any)
	if len(choices) == 0 {
		return ""
	}
	c, _ := choices[0].(map[string]any)
	fr, _ := c["finish_reason"].(string)
	return fr
}

func TestRefusalStreamDeliversTheReasonAsTheAnswer(t *testing.T) {
	// The buffered lane still owns every byte, so it SUBSTITUTES an answer. It has to
	// look like an ordinary reply or the client renders a transport error and many
	// harnesses retry it — one refusal becoming a retry storm.
	f := frames(t, refusalStream("gpt-4o", "refused by policy"))
	if len(f) != 2 {
		t.Fatalf("want 2 frames, got %d", len(f))
	}
	choices, _ := f[0]["choices"].([]any)
	c, _ := choices[0].(map[string]any)
	delta, _ := c["delta"].(map[string]any)
	if delta["content"] != "refused by policy" {
		t.Errorf("the reason is not delivered as assistant content: %v", delta)
	}
	if delta["role"] != "assistant" {
		t.Errorf("first frame must open an assistant message, got %v", delta["role"])
	}
	if got := finishReason(t, f[1]); got != "content_filter" {
		// Not `stop`: a client that logs or retries on the finish reason has to be
		// able to tell a refusal from a completed reply.
		t.Errorf("finish_reason = %q, want content_filter", got)
	}
}

func TestContentFilterFramesOnlyRetract(t *testing.T) {
	// The passthrough lane has already delivered the text. All it can do is tell the
	// client to take the message back — it must NOT append prose, which would land
	// under an answer the user already read.
	sse := contentFilterFrames("gpt-4o")
	f := frames(t, sse)
	if len(f) != 1 {
		t.Fatalf("want 1 frame, got %d", len(f))
	}
	if got := finishReason(t, f[0]); got != "content_filter" {
		t.Errorf("finish_reason = %q, want content_filter", got)
	}
	choices, _ := f[0]["choices"].([]any)
	c, _ := choices[0].(map[string]any)
	delta, _ := c["delta"].(map[string]any)
	if len(delta) != 0 {
		t.Errorf("a retraction must add no content, got %v", delta)
	}
}

func TestBothEndTheStream(t *testing.T) {
	// Without the terminator an OpenAI-compatible client waits for more forever —
	// the response is paused at this filter, so nothing else will send it.
	for name, sse := range map[string]string{
		"refusal":    refusalStream("m", "no"),
		"retraction": contentFilterFrames("m"),
	} {
		if !strings.HasSuffix(sse, "data: [DONE]\n\n") {
			t.Errorf("%s does not terminate the stream: %q", name, sse)
		}
	}
}
