package main

// The plugin's only state — and it lives for ONE REQUEST.
//
// ⚠️ This file used to be the reason the plugin needed Redis: the placeholder map,
// the already-reported marks and the conversation chain all had to survive across
// requests, and Envoy gives every worker thread its own Wasm VM. All of it moved to
// the runtime, and v0.7 finished the move: the runtime holds the session, numbers
// the placeholders, and answers each request with `modifications.spans` covering
// every occurrence of a known value IN THIS BODY — history included, because the
// whole conversation is in the body. Nothing here outlives the request.

// sessionState is the masking context for one request.
type sessionState struct {
	// The runtime's session id, read off the verdict. Diagnostics only: nothing here
	// keys on it.
	ID string

	// Mapping is token -> plaintext, learned from the spans this request APPLIED
	// (the runtime's replacement token; the bytes it displaced). It is what restores
	// the model's reply: the model may echo `${OGR_EMAIL_1}` and the caller must
	// receive its own data back.
	Mapping map[string]string
}

// The most placeholders one request may carry. A body past this is not being
// redacted, it is being copied — and the runtime applies the same bound to what it
// returns.
const maxTokens = 256

func newSessionState(id string) *sessionState {
	return &sessionState{ID: id, Mapping: map[string]string{}}
}

// adopt records the token→value bindings a span application learned.
func (s *sessionState) adopt(learned map[string]string) {
	for token, value := range learned {
		if len(s.Mapping) >= maxTokens {
			return
		}
		if token != "" && value != "" {
			s.Mapping[token] = value
		}
	}
}
