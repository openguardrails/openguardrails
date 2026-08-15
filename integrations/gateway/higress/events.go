package main

import (
	"bytes"
	"encoding/json"

	"github.com/tidwall/gjson"
)

// One proxied model call → OGR v0.8 GuardEvents.
//
// This file used to be a 900-line derivation: it classified the conversation into
// turns, actions and outcomes, decided what was NEW, itemised history, carried a
// transcript envelope for the judge, and registered every judged text under a
// payload path so verdict spans could be resolved. All of that was the plugin doing
// the RUNTIME's job, and the spec makes the split explicit (the recipe in
// specification/runtime-api.md): the gateway is a RAW FORWARDER. One proxied model
// call is one STEP, reported as two events —
//
//	step/request    the provider request body, untouched, before the model sees it
//	step/response   the provider response body (or the canonical shape reassembled
//	                from the SSE stream), before the caller acts on it
//
// — and the runtime classifies, derives session/turn/step, and answers with spans
// whose paths name locations in the body we forwarded. The gateway declares NO
// coordinates: a proxy sees one stateless call at a time, and pretending otherwise is
// how two implementations of one algorithm drift.
//
// v0.8 shrank the event to TEN fields, all required (`additionalProperties: false`):
// kind, step_id, the identity five-tuple, llm_protocol, payload. What a runtime can
// derive left the wire entirely — no ogr_version (the runtime adapts to what it
// receives), no timestamp (receive time), no integration build id (that fact lives
// on the heartbeat now, where fleet coverage and bad-rollout triage read it). The
// five-tuple is required WITH the empty string as the explicit "no assertion", so an
// integrator answers the identity question instead of falling into the API-key
// floor by omission.
//
// ⚠️ THE PAYLOAD IS THE BODY'S OWN BYTES (json.RawMessage), never a re-marshalled
// parse of them. A verdict's span offsets index the payload AS TRANSPORTED; parsing
// and re-encoding reorders keys and re-escapes strings, so every offset would land in
// different bytes than the runtime counted.

const (
	integrationName = "ogr-higress"
	// Reported in the heartbeat (and nowhere else — v0.8 took the build id off the
	// event), so it is how a deployment learns which build is in the VM. Kept honest
	// by TestPluginVersionMatchesTheVERSIONFile — 1.3.0 and 1.4.0 both shipped while
	// a prior constant still said 1.2.0.
	pluginVersion = "3.0.2"

	kindStepRequest  = "step/request"
	kindStepResponse = "step/response"
)

func integrationID() string { return integrationName + "/" + pluginVersion }

// identity is the flat agent five-tuple, embedded into every GuardEvent — the
// agent_ prefixes are the namespace, no envelope. The consumer the gateway
// authenticated IS the agent (`agent_id`), the consumer-group is the agent's
// WORKSPACE. Owner and user are attributes; they never select configuration. Every
// field is a claim the runtime resolves inside the org the API key proves.
//
// ⚠️ NO omitempty — v0.8 requires all five on every event, with "" as the explicit
// "no assertion". An absent field is a schema violation, not a shorter event.
type identity struct {
	AgentID        string `json:"agent_id"`
	AgentType      string `json:"agent_type"`
	AgentWorkspace string `json:"agent_workspace"`
	AgentOwner     string `json:"agent_owner"`
	AgentUser      string `json:"agent_user"`
}

// GuardEvent is the wire unit: exactly the ten v0.8 fields, every one required. A
// struct, so encoding/json does the escaping (the old connector hand-rolled its JSON
// and every field it interpolated was an injection surface) and so a field cannot
// leak onto the wire — the schema is `additionalProperties: false`.
type GuardEvent struct {
	Kind string `json:"kind"`
	// StepID binds the step/request and step/response of ONE proxied model call —
	// the one coordinate v0.8 kept, because concurrency makes it underivable.
	StepID string `json:"step_id"`
	// Flat identity fields, inlined into the top level of the wire object.
	identity
	LLMProtocol string `json:"llm_protocol"`
	// Payload carries the provider body verbatim (see the file comment), or the
	// canonical object marshalled by this file.
	Payload json.RawMessage `json:"payload"`
}

// subjectOf assembles the per-request agent identity. The consumer IS the agent: one
// consumer credential, one agent row. One credential driving several harnesses at
// once stays ONE agent — the runtime surfaces that as a shadow-agent signal, not a
// reason to split the inventory here. All-empty is the key-only floor, where the
// runtime derives the agent from the API key.
func subjectOf(agentID, agentType, workspace, owner, user string) identity {
	return identity{
		AgentID:        agentID,
		AgentType:      agentType,
		AgentWorkspace: workspace,
		AgentOwner:     owner,
		AgentUser:      user,
	}
}

// deriveCtx is what every event of one proxied call shares.
type deriveCtx struct {
	subj   identity
	stepID string
	// The CLIENT's wire protocol, detected per request. Never a constant: it was
	// `openai.chat` for every event an old build sent, which made 693,197 stored
	// events unfalsifiable. v0.8 makes the field REQUIRED, which is why a request
	// whose protocol cannot be established sends no event at all (see the
	// unrecognised-body policy in main.go) — inventing an enum value here would be
	// the same lie at schema strength.
	protocol string
}

func (d *deriveCtx) event(kind string, payload json.RawMessage) *GuardEvent {
	return &GuardEvent{
		Kind:        kind,
		StepID:      d.stepID,
		LLMProtocol: d.protocol,
		identity:    d.subj,
		Payload:     payload,
	}
}

// requestEvent is the step's first half: the provider request body, verbatim.
func requestEvent(d *deriveCtx, rawBody []byte) *GuardEvent {
	return d.event(kindStepRequest, json.RawMessage(rawBody))
}

// responseEvent is the step's second half for a buffered reply: the provider
// response body, verbatim.
func responseEvent(d *deriveCtx, rawBody []byte) *GuardEvent {
	return d.event(kindStepResponse, json.RawMessage(rawBody))
}

// responseEventTimed is responseEvent plus the step's observed timing, spliced
// into the raw body as a top-level `timing` key — the one fact a buffered reply
// has that its own bytes cannot carry (the provider stamps no wall clock), and
// which only the thing in the byte path can measure.
//
// ⚠️ SPLICED BY BYTE INSERTION, never by parse-and-re-marshal. A verdict's span
// offsets index the string values of the payload AS TRANSPORTED, and Go's JSON
// encoder re-escapes on the way out (`<` becomes `\u003c`), so a re-marshalled body
// would put every offset into bytes the runtime never counted. Inserting one
// sibling key right after the opening `{` leaves every original byte — and every
// string a span can name — exactly where it was.
func responseEventTimed(d *deriveCtx, rawBody []byte, timing *canonicalTiming) *GuardEvent {
	return d.event(kindStepResponse, json.RawMessage(spliceTiming(rawBody, timing)))
}

func spliceTiming(rawBody []byte, timing *canonicalTiming) []byte {
	if timing == nil {
		return rawBody
	}
	trimmed := bytes.TrimLeft(rawBody, " \t\r\n")
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return rawBody // not a JSON object: forward untouched, report nothing extra
	}
	// No provider protocol has a top-level `timing`; if one ever appears, keep
	// the body verbatim rather than write a duplicate key.
	if gjson.ParseBytes(trimmed).Get("timing").Exists() {
		return rawBody
	}
	blob, err := json.Marshal(timing)
	if err != nil {
		return rawBody
	}
	rest := trimmed[1:]
	sep := ","
	if next := bytes.TrimLeft(rest, " \t\r\n"); len(next) > 0 && next[0] == '}' {
		sep = "" // `{}` — a degenerate but valid body
	}
	out := make([]byte, 0, len(trimmed)+len(blob)+16)
	out = append(out, `{"timing":`...)
	out = append(out, blob...)
	out = append(out, sep...)
	out = append(out, rest...)
	return out
}

// canonicalResponse is the step's second half for a STREAMED reply, where no single
// raw body exists to forward: the canonical shape the spec defines, reassembled from
// the SSE frames.
//
// ⚠️ `arguments` is the argument OBJECT, not a JSON string of it — the runtime reads
// `arguments.command` to recover the bare command a shell action carries, and a
// string here hands the judge `"{\"command\":\"rm -rf /\"}"` where it was trained on
// `rm -rf /`. The raw argument text is re-used verbatim (jsonRaw) so the runtime
// reads the same bytes the model produced.
type canonicalToolCall struct {
	ID        string  `json:"id,omitempty"`
	Name      string  `json:"name"`
	Arguments jsonRaw `json:"arguments,omitempty"`
}

type canonicalTiming struct {
	StartedAt    string `json:"started_at,omitempty"`
	FirstTokenAt string `json:"first_token_at,omitempty"`
	CompletedAt  string `json:"completed_at,omitempty"`
}

// canonicalUsage is the provider's token accounting in the canonical counter
// names the runtime ingests verbatim (`events.input_tokens` and friends — the
// same five dsh reports). input/output stay present at 0 when the provider
// reported a usage object at all; the detail counters are omitted at 0 because
// most providers never report them.
type canonicalUsage struct {
	InputTokens      int64 `json:"input_tokens"`
	OutputTokens     int64 `json:"output_tokens"`
	ReasoningTokens  int64 `json:"reasoning_tokens,omitempty"`
	CacheReadTokens  int64 `json:"cache_read_tokens,omitempty"`
	CacheWriteTokens int64 `json:"cache_write_tokens,omitempty"`
}

type canonicalPayload struct {
	Text      string              `json:"text,omitempty"`
	Reasoning string              `json:"reasoning,omitempty"`
	ToolCalls []canonicalToolCall `json:"tool_calls,omitempty"`
	Model     string              `json:"model,omitempty"`
	Usage     *canonicalUsage     `json:"usage,omitempty"`
	Timing    *canonicalTiming    `json:"timing,omitempty"`
}

func responseEventCanonical(d *deriveCtx, p canonicalPayload) *GuardEvent {
	blob, err := json.Marshal(p)
	if err != nil {
		// A canonical payload is built from strings this file assembled; a marshal
		// failure here is unreachable, but an empty object is still a valid event.
		blob = []byte("{}")
	}
	return d.event(kindStepResponse, blob)
}

// There is no "unparsed" diagnostic event anymore. v0.7 sent one (`{"unparsed":
// true, "reason", "bytes"}`) for traffic the plugin recognised and could not read,
// because silence is indistinguishable from health. v0.8 removed the room for it:
// `llm_protocol` is a required closed enum and the payload must be a provider body
// or the canonical shape — a fabricated protocol name would make 693k-events-style
// unfalsifiable data, and a fabricated payload would make the guardrails judge a
// fiction. The job of making the gap visible moved to where the spec puts every
// lost observation: the `unreadable` counter on the heartbeat, plus a log line.
// (See degraded-mode.md — heartbeat counters are what keep an observability gap
// from being silent.)

// jsonRaw is a pre-serialized JSON fragment that marshals as itself. Degrades to a
// JSON string when the fragment is not valid JSON, so a truncated argument stream
// cannot break the whole event.
type jsonRaw string

func (j jsonRaw) MarshalJSON() ([]byte, error) {
	if j == "" {
		return []byte("null"), nil
	}
	if json.Valid([]byte(j)) {
		return []byte(j), nil
	}
	return json.Marshal(string(j))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
