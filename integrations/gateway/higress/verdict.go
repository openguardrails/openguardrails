package main

import (
	"encoding/json"
	"strings"

	"github.com/tidwall/gjson"
)

// Reading a Verdict, and rendering a refusal the caller's client can display.

// stopsRequest reports whether a decision must not reach the model.
//
// `require_approval` means "the runtime holds the action and asks a human". A
// gateway has nobody to ask, so it degrades to a refusal rather than passing —
// the conservative direction. Nothing in the runtime produces it today
// (docs/roadmap.md #1), so this is a guard against a future producer, not a live
// branch.
func stopsRequest(decision string) bool {
	return decision == "block" || decision == "require_approval"
}

// refusalReason is what the end user reads. A verdict's `reasons` are written
// for an operator, so the first one is used as-is only when it exists; the
// fallback says what happened without describing what was detected, which would
// hand an attacker a detector oracle.
func refusalReason(v gjson.Result) string {
	for _, r := range v.Get("reasons").Array() {
		if s := strings.TrimSpace(r.String()); s != "" {
			return s
		}
	}
	for _, f := range v.Get("findings").Array() {
		if t := strings.TrimSpace(f.Get("title").String()); t != "" {
			return t
		}
	}
	return "This request was refused by the organization's AI usage policy."
}

// refusalBody renders an OpenAI chat completion carrying the refusal AS THE
// ASSISTANT MESSAGE, with HTTP 200.
//
// ⚠️ 200, not 4xx, on purpose: every OpenAI-compatible client renders an
// assistant message, while a 4xx surfaces as a generic transport failure that
// explains nothing to the person who typed the prompt — and many agent harnesses
// retry it, turning one refusal into a retry storm.
func refusalBody(model, reason string) string {
	type message struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	type choice struct {
		Index        int     `json:"index"`
		Message      message `json:"message"`
		FinishReason string  `json:"finish_reason"`
	}
	body := struct {
		ID      string   `json:"id"`
		Object  string   `json:"object"`
		Model   string   `json:"model"`
		Choices []choice `json:"choices"`
	}{
		ID:     "chatcmpl-ogr-refusal",
		Object: "chat.completion",
		Model:  model,
		Choices: []choice{{
			Index:        0,
			Message:      message{Role: "assistant", Content: reason},
			FinishReason: "content_filter",
		}},
	}
	out, err := json.Marshal(body)
	if err != nil {
		return `{"error":{"message":"refused"}}`
	}
	return string(out)
}

// refusalStream is `refusalBody` for a stream: the refusal delivered as the assistant
// message, in SSE frames, so the buffered lane substitutes an answer the client
// renders normally rather than a transport error it retries.
func refusalStream(model, reason string) string {
	first, _ := json.Marshal(map[string]any{
		"id": "chatcmpl-ogr", "object": "chat.completion.chunk", "model": model,
		"choices": []map[string]any{{"index": 0,
			"delta": map[string]any{"role": "assistant", "content": reason}}},
	})
	// ⚠️ `content_filter`, not `stop`, even though the caller never saw the model's
	// own answer. The finish reason states WHY the turn ended, and a client that logs
	// or retries on it must be able to tell a refusal from a completed reply.
	last, _ := json.Marshal(map[string]any{
		"id": "chatcmpl-ogr", "object": "chat.completion.chunk", "model": model,
		"choices": []map[string]any{{"index": 0, "delta": map[string]any{},
			"finish_reason": "content_filter"}},
	})
	return "data: " + string(first) + "\n\ndata: " + string(last) + "\n\ndata: [DONE]\n\n"
}

// contentFilterFrames ends a passthrough stream the final judgement refused.
//
// ⚠️ This is a RETRACTION, not a block. The text is already on the caller's screen;
// the frame is what tells an OpenAI-compatible client to take the message back. A
// deployment that cannot accept that exposure has to be on the buffered lane, which is
// what `x.ogr.output_mode` exists to decide.
func contentFilterFrames(model string) string {
	last, _ := json.Marshal(map[string]any{
		"id": "chatcmpl-ogr", "object": "chat.completion.chunk", "model": model,
		"choices": []map[string]any{{"index": 0, "delta": map[string]any{},
			"finish_reason": "content_filter"}},
	})
	return "data: " + string(last) + "\n\ndata: [DONE]\n\n"
}
