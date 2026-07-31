package main

import "github.com/tidwall/sjson"

// setContent rewrites the assistant message of a buffered chat completion.
// sjson rather than a string replace: the content is a JSON string field, and
// an already-escaped value spliced in by hand corrupts the document the moment
// the plaintext contains a quote or a backslash.
func setContent(body, content string) (string, error) {
	return sjson.Set(body, "choices.0.message.content", content)
}
