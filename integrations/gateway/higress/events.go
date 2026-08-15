package main

import (
	"encoding/json"
)

// One proxied model call → OGR v0.7 GuardEvents.
//
// This file used to be a 900-line derivation: it classified the conversation into
// turns, actions and outcomes, decided what was NEW, itemised history for /ingest,
// carried a transcript envelope for the judge, and registered every judged text under
// a payload path so verdict spans could be resolved. All of that was the plugin doing
// the RUNTIME's job, and v0.7 makes the split explicit (Recipe B of the runtime-api
// spec): the gateway is a RAW FORWARDER. One proxied model call is one STEP, reported
// as two events —
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
// ⚠️ THE PAYLOAD IS THE BODY'S OWN BYTES (json.RawMessage), never a re-marshalled
// parse of them. A verdict's span offsets index the payload AS TRANSPORTED; parsing
// and re-encoding reorders keys and re-escapes strings, so every offset would land in
// different bytes than the runtime counted.

const (
	ogrVersion      = "0.7"
	integrationName = "ogr-higress"
	// Reported on every event and in the heartbeat, so it is how a deployment learns
	// which build is in the VM. Kept honest by TestPluginVersionMatchesTheVERSIONFile —
	// 1.3.0 and 1.4.0 both shipped while a prior constant still said 1.2.0.
	pluginVersion = "2.1.0"

	kindStepRequest  = "step/request"
	kindStepResponse = "step/response"
)

func integrationID() string { return integrationName + "/" + pluginVersion }

// identity is the flat v0.7 agent five-tuple, embedded into every GuardEvent — the
// agent_ prefixes are the namespace, no envelope. The consumer the gateway
// authenticated IS the agent (`agent_id`), the consumer-group is the agent's
// WORKSPACE. Owner and user are attributes; they never select configuration. Every
// field is a claim the runtime resolves inside the org the API key proves.
//
// v0.7 has no `attestation` field — the ladder went with the enrollment machinery.
type identity struct {
	AgentID        string `json:"agent_id,omitempty"`
	AgentType      string `json:"agent_type,omitempty"`
	AgentWorkspace string `json:"agent_workspace,omitempty"`
	AgentOwner     string `json:"agent_owner,omitempty"`
	AgentUser      string `json:"agent_user,omitempty"`
}

// GuardEvent is the wire unit. A struct, so encoding/json does the escaping: the old
// connector hand-rolled its JSON and every field it interpolated was an injection
// surface.
type GuardEvent struct {
	OGRVersion string `json:"ogr_version"`
	Kind       string `json:"kind"`
	// StepID binds the step/request and step/response of ONE proxied model call —
	// the only correlation a gateway can honestly assert.
	StepID      string `json:"step_id,omitempty"`
	Timestamp   string `json:"timestamp"`
	Integration string `json:"integration"`
	LLMProtocol string `json:"llm_protocol,omitempty"`
	// Flat v0.7 identity fields, inlined into the top level of the wire object.
	identity
	// Payload carries the provider body verbatim (see the file comment), or a
	// canonical/diagnostic object marshalled by this file.
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
	now    string
	// The CLIENT's wire protocol, detected per request. Never a constant: it was
	// `openai.chat` for every event an old build sent, which made 693,197 stored
	// events unfalsifiable.
	protocol string
}

func (d *deriveCtx) event(kind string, payload json.RawMessage) *GuardEvent {
	return &GuardEvent{
		OGRVersion:  ogrVersion,
		Kind:        kind,
		StepID:      d.stepID,
		Timestamp:   d.now,
		Integration: integrationID(),
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

type canonicalPayload struct {
	Text      string              `json:"text,omitempty"`
	Reasoning string              `json:"reasoning,omitempty"`
	ToolCalls []canonicalToolCall `json:"tool_calls,omitempty"`
	Model     string              `json:"model,omitempty"`
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

// unparsedEvent is what the plugin sends when it saw completion traffic and could not
// read it — an unknown protocol, or a stream no decoder reassembled.
//
// ⚠️ It exists because the alternative is SILENCE, and silence is indistinguishable
// from health: HTTP 200 to the client, no warning, no error, no counter, and no row
// anywhere saying traffic passed unjudged. It carries NO text — we could not read the
// body, and inventing a payload would make the guardrails judge a fiction. What it
// carries is the fact of the traffic: why, and how big.
func unparsedEvent(d *deriveCtx, kind, reason string, bodyBytes int) *GuardEvent {
	blob, _ := json.Marshal(map[string]any{
		"unparsed": true,
		"reason":   reason,
		"bytes":    bodyBytes,
	})
	return d.event(kind, blob)
}

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
