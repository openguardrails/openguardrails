package main

import (
	"strconv"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// setContent rewrites the assistant message of a buffered chat completion.
// sjson rather than a string replace: the content is a JSON string field, and
// an already-escaped value spliced in by hand corrupts the document the moment
// the plaintext contains a quote or a backslash.
func setContent(body, content string) (string, error) {
	return sjson.Set(body, "choices.0.message.content", content)
}

// restoreBody puts the plaintext back into a BUFFERED reply — the prose and
// every tool call's arguments — and reports whether anything changed.
//
// ⚠️ The arguments are not an afterthought, they are the half that MATTERS. An
// unrestored line of prose is a cosmetic defect the reader can see; an
// unrestored `{"to": "${OGR_EMAIL_1}"}` is an agent acting on a value that
// names nothing — sending mail to a placeholder, looking up a customer who does
// not exist — and nothing in the reply says so.
func restoreBody(body string, mapping map[string]string) (string, bool) {
	if len(mapping) == 0 {
		return body, false
	}
	out, changed := body, false

	message := gjson.Get(out, "choices.0.message")
	if content := message.Get("content"); content.Type == gjson.String {
		if restored := restoreString(content.String(), mapping); restored != content.String() {
			if next, err := setContent(out, restored); err == nil {
				out, changed = next, true
			}
		}
	}
	for i, tc := range message.Get("tool_calls").Array() {
		args := tc.Get("function.arguments")
		if args.Type != gjson.String {
			continue
		}
		restored := restoreString(args.String(), mapping)
		if restored == args.String() {
			continue
		}
		path := "choices.0.message.tool_calls." + strconv.Itoa(i) + ".function.arguments"
		if next, err := sjson.Set(out, path, restored); err == nil {
			out, changed = next, true
		}
	}
	return out, changed
}
