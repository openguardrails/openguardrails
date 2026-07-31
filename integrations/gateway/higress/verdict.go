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

// refusalStream renders the same refusal as an SSE stream, for a request that
// asked for one. A streaming client discards a non-SSE body, so returning the
// object form here would show the user an empty reply and hide the reason.
func refusalStream(model, reason string) string {
	type delta struct {
		Role    string `json:"role,omitempty"`
		Content string `json:"content,omitempty"`
	}
	type choice struct {
		Index        int     `json:"index"`
		Delta        delta   `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	}
	frame := func(c choice) string {
		out, err := json.Marshal(struct {
			ID      string   `json:"id"`
			Object  string   `json:"object"`
			Model   string   `json:"model"`
			Choices []choice `json:"choices"`
		}{"chatcmpl-ogr-refusal", "chat.completion.chunk", model, []choice{c}})
		if err != nil {
			return ""
		}
		return "data: " + string(out) + "\n\n"
	}
	stop := "content_filter"
	var b strings.Builder
	b.WriteString(frame(choice{Delta: delta{Role: "assistant", Content: reason}}))
	b.WriteString(frame(choice{Delta: delta{}, FinishReason: &stop}))
	b.WriteString("data: [DONE]\n\n")
	return b.String()
}
