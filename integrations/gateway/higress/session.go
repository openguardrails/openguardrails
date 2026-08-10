package main

// The plugin's only state — and it lives for ONE REQUEST.
//
// ⚠️ **THIS FILE USED TO BE THE REASON THE PLUGIN NEEDED REDIS.** It held four facts
// across requests, all of them about a conversation rather than about a request:
//
//	1. the placeholder map, `${OGR_PHONE_1}` -> the number, to restore the reply;
//	2. the same map by value, so a turn-1 value re-masked to its established token when
//	   the client re-sent the whole conversation in the clear on turn 2;
//	3. which user turn / tool_call ids / tool set had already been reported, so history
//	   was not re-reported every turn;
//	4. the conversation chain, i.e. which session this request continued.
//
// None of it could live in Go memory: Envoy gives every worker thread its own Wasm VM
// and round-robins connections, so turn 1 and turn 2 of one conversation land in
// different VMs (measured — workers 712 then 701 on consecutive requests). So it went
// to Redis, sealed, and this filter became a stateful data-plane element with a store
// to operate, a key to rotate, and a second implementation of the runtime's own session
// algorithm.
//
// All four moved to the runtime on 2026-08-10 (docs/proposals/stateless-pep.md):
//
//	1+2. `x.ogr.redaction_map` on the verdict — every placeholder whose value appears in
//	     THIS request, which is exactly the set this turn must mask and restore.
//	3.   `protocol.Conversation.NewInput()` is purely structural (everything after the
//	     last assistant turn), so what is NEW needs no memory; the tool set rides every
//	     turn and the runtime drops it when its digest has not moved.
//	4.   `x.ogr.session_id` — the runtime derives it from `authz.transcript`, which this
//	     plugin was already sending.
//
// ⚠️ And the VM argument evaporates with them: a request's REQUEST and RESPONSE phases
// run in the same VM. Only turns of a conversation land in different ones, and nothing
// here spans turns any more.
//
// ⚠️ What did NOT move is the work: this filter still parses three protocols, rewrites
// request and response bodies, and owns the response flow. "Only forwarding" was never
// reachable — masking means changing bytes, and only the thing in the path can.

// sessionState is the masking context for one request.
//
// The name is kept because it is what every call site says, and because the map it
// holds IS session-scoped — it is just that the runtime is what makes it so now.
type sessionState struct {
	// The runtime's session id, read off the verdict. Diagnostics only: nothing here
	// keys on it, which is why an older runtime returning none costs nothing.
	ID string

	Mapping map[string]string // token -> plaintext
	ByValue map[string]string // plaintext -> token

	// Local placeholder numbering, used ONLY when a verdict carried neither a
	// `modifications` block nor a redaction map — see `learnValues`. Per request, so
	// the numbering restarts; that is sound precisely because it is a fallback for a
	// verdict that named no tokens of its own.
	Counters map[string]int
}

/**
 * The most placeholders one request may carry. A turn past this is not being redacted,
 * it is being copied — and the runtime applies the same bound to what it returns.
 */
const maxTokens = 256

func newSessionState(id string) *sessionState {
	return &sessionState{
		ID:       id,
		Mapping:  map[string]string{},
		ByValue:  map[string]string{},
		Counters: map[string]int{},
	}
}

// adopt takes the runtime's answer for this request.
//
// ⚠️ It is not merged into anything that outlives the request — that is the whole
// change. The map already contains the sticky half (values bound on earlier turns whose
// text is in this request) because the runtime filtered its session map down to what
// this request actually contains.
func (s *sessionState) adopt(m map[string]string) {
	for token, value := range m {
		s.remember(token, value)
	}
}

// remember binds a value to a token for the rest of THIS request.
func (s *sessionState) remember(token, value string) {
	if len(s.Mapping) >= maxTokens {
		return
	}
	s.Mapping[token] = value
	s.ByValue[value] = token
}

// nextNumber reserves the next placeholder number for a type. Fallback path only.
func (s *sessionState) nextNumber(typeName string) int {
	s.Counters[typeName]++
	return s.Counters[typeName]
}

// redactions renders the map as masking instructions, so every resent turn of the
// history is masked with the token the model already saw.
func (s *sessionState) redactions() []Redaction {
	out := make([]Redaction, 0, len(s.ByValue))
	for value, token := range s.ByValue {
		out = append(out, Redaction{Token: token, Value: value})
	}
	return out
}
