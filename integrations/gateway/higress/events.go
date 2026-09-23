package main

import (
	"bytes"
	"encoding/json"
	"time"

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
// kind, step_id, the identity four-tuple, llm_protocol, payload. What a runtime can
// derive left the wire entirely — no ogr_version (the runtime adapts to what it
// receives), no timestamp (receive time), no integration build id (that fact lives
// on the heartbeat now, where fleet coverage and bad-rollout triage read it). The
// four-tuple is required WITH the empty string as the explicit "no assertion", so an
// integrator answers the identity question instead of falling into the API-key
// floor by omission.
//
// ⚠️ THE PAYLOAD IS THE BODY'S OWN BYTES (json.RawMessage), never a re-marshalled
// parse of them. A verdict's span offsets index the payload AS TRANSPORTED; parsing
// and re-encoding reorders keys and re-escapes strings, so every offset would land in
// different bytes than the runtime counted.

const (
	integrationName = "ogr-higress"
	// Reported on EVERY EVENT and in the heartbeat (3.2.0 restored the event's copy;
	// 3.0.0–3.1.0 had only the beat), so it is how a deployment learns which build is
	// in the VM. Kept honest by TestPluginVersionMatchesTheVERSIONFile — 1.3.0 and
	// 1.4.0 both shipped while a prior constant still said 1.2.0.
	pluginVersion = "3.15.2"

	kindStepRequest  = "step/request"
	kindStepResponse = "step/response"
)

func integrationID() string { return integrationName + "/" + pluginVersion }

// identity is the flat agent four-tuple, embedded into every GuardEvent — the
// agent_ prefixes are the namespace, no envelope. The consumer the gateway
// authenticated IS the agent (`agent_id`), the consumer-group is the agent's
// WORKSPACE. `agent_user` is an attribute; it never selects configuration. Every
// field is a claim the runtime resolves inside the org the API key proves.
//
// ⚠️ NO omitempty — v0.8 requires all four on every event, with "" as the explicit
// "no assertion". An absent field is a schema violation, not a shorter event.
//
// ⚠️ There is no `agent_owner` (removed 2026-08-17). Who is ACCOUNTABLE for an
// agent is not something this gateway can assert: it was a header a route
// injected, re-asserted on every request, and a runtime cannot rest a permission
// on that. Ownership is a link to a console account an admin assigns.
type identity struct {
	AgentID        string `json:"agent_id"`
	AgentType      string `json:"agent_type"`
	AgentWorkspace string `json:"agent_workspace"`
	AgentUser      string `json:"agent_user"`
}

// GuardEvent is the wire unit: the eight required v1.0 fields plus the optional
// `integration` and `connection`. A struct, so encoding/json does the escaping (the old
// connector hand-rolled its JSON and every field it interpolated was an injection
// surface) and so a field cannot leak onto the wire — the schema is
// `additionalProperties: false`.
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
	// Integration is WHO REPORTED IT — `integrationID()`, i.e. "name/version".
	//
	// ⚠️ Restored to the event 2026-08-17, after the heartbeat-only version failed
	// the first time anyone needed it. Two silent failures compounded on a customer
	// deployment: a runtime's liveness row is unique on (org, NAME) — it has to be,
	// so a rollout updates its row instead of minting a second — so that gateway's
	// two replicas at 3.0.2 and a lab instance at 3.1.0 all wrote ONE row, and the
	// row read 3.1.0: the only instance sending no traffic at all. Separately, a beat
	// is its own channel and can go quiet by itself (blocked egress, a tick that
	// never fires) exactly when a bad rollout is what you are trying to name.
	//
	// On the event neither is possible — the build travels with the traffic it
	// produced, no other reporter can overwrite it, and stored events split by build.
	// The heartbeat's copy stays the LIVENESS signal; this one is the TRIAGE signal.
	//
	// ⚠️ Deliberately NOT omitempty: `integrationID()` is built from two compile-time
	// constants and can never be empty, so omitempty could only ever hide a bug. That
	// is a different rule from the four-tuple's (see `identity`), where "" is itself a
	// meaningful assertion and omitting it would be a schema violation.
	Integration string `json:"integration"`
	// Connection is WHICH DOWNSTREAM FLOW carried this request —
	// `<instance>#<envoy connection ordinal>` (`connectionID()` in main.go),
	// opaque to the runtime, stable for the life of one client connection.
	//
	// The one session signal a CLIENT cannot strip: the runtime reassembles
	// sessions from the conversation each request carries, and both content
	// signals were measured failing at once (2026-08-19) — a harness that
	// tail-trims its history rewrites every prefix the chain fingerprints, and
	// a bridge that strips `metadata` removes every id the client asserted —
	// while the keep-alive connection under them never changed. The runtime
	// uses it as a corroborated LAST-RESORT grouping signal only (a connection
	// names a process, which may hold several concurrent conversations).
	//
	// ⚠️ omitempty, unlike Integration: a wasm host that will not answer the
	// connection property has nothing to assert, and the field is OPTIONAL on
	// the wire exactly so absence stays valid.
	Connection string `json:"connection,omitempty"`
	// Initiator is WHO STARTED the work this step belongs to (OGR 1.5):
	// "scheduled" when the client declared a scheduled run, "" (omitted) when it
	// declared nothing — which is the normal case and is NOT a claim that a person
	// is present.
	//
	// It exists because a harness's scheduled runs may carry NO in-band marker at
	// all. The runtime reads a scheduler banner out of the prompt for itself and
	// catches hermes, openclaw and opensquilla that way; Claude Code's cron injects
	// the user's own prompt verbatim and says so only in a request header, which the
	// body cannot carry and only something in the request path can see. That is this
	// gateway. See `workloadInitiator` in main.go.
	//
	// ⚠️ SELF-DECLARED, like `integration` — the client writes the header — so it is
	// a RECORD and never an input to a decision. The runtime enforces that; nothing
	// here may start reading it.
	//
	// ⚠️ omitempty, and "spawned" is deliberately never emitted: a gateway sees one
	// request, not the session tree that would tell it who spawned whom.
	Initiator string `json:"initiator,omitempty"`
	// LlmEndpoint is WHERE THE CLIENT POINTED THE MODEL REQUEST (OGR 1.6): the
	// `:authority` this gateway RECEIVED, lower-cased, `host[:port]`. It is the
	// address the agent DIALLED — before this gateway's own routing and before
	// ai-proxy rewrites the upstream — which is exactly the question the field asks
	// (spec § llm_endpoint: "where did the agent dial, not who finally served it").
	//
	// What it buys the runtime is the one signal a body cannot carry: a credential
	// sitting in the context goes wherever the request goes, and a request pointed at
	// a host that is no known vendor and not the tenant's own names a RELAY.
	//
	// ⚠️ SELF-DECLARED like `integration` and `initiator` — a RECORD, never an input
	// to a decision; the runtime enforces that. ⚠️ omitempty: a host that answers no
	// authority sends nothing rather than "".
	LlmEndpoint string `json:"llm_endpoint,omitempty"`
	// Transport is WHERE THE TIME WENT on the way to a verdict (OGR 1.8) — see the
	// `transport` type. Omitted whole when nothing was measured.
	Transport *transport `json:"transport,omitempty"`
}

// transport carries the hop durations this gateway can measure, so a TTFT
// regression is attributable to a LAYER instead of argued about.
//
// ⚠️⚠️ **EVERY FIELD IS A DURATION MEASURED INSIDE ONE CLOCK, AND THAT IS THE WHOLE
// DESIGN.** The obvious build — stamp four timestamps, subtract the neighbours —
// produces one number spanning two machines' clocks, and it is not a small error:
// this gateway's own `timing.completed_at` was once measured a steady 2.1s AHEAD of
// the runtime's receive time on 2,997 of 3,000 events, on a LAB box whose container
// clock matched its host to under a second. Read as network, that is two seconds of
// fiction. `timing`'s spec section states the rule; this type obeys it.
//
// `NetMs` is the exception that proves it: it is the round trip THIS process timed,
// minus the `server_ms` the runtime reported for the same call — two same-clock
// differences subtracted, which is the NTP delay formula and needs no synchronised
// clocks. ⚠️ It does not split into outbound and inbound. That split is unavailable
// without synchronised clocks and must not be invented by halving this.
type transport struct {
	// GwMs: Envoy received the request → this plugin's hook ran. Filter chain and
	// body buffering, i.e. everything the gateway does before a guardrail exists.
	GwMs int64 `json:"gw_ms,omitempty"`
	// PluginMs: this plugin's hook entry → the event was BUILT.
	//
	// ⚠️ The final `json.Marshal` and the dispatch itself are OUTSIDE this number and
	// outside `NetMs` (which starts at the dispatch). That sliver is the copy of an
	// already-serialised payload, and naming it here is better than folding it into
	// "network", where it would be indistinguishable from a slow hop.
	PluginMs int64 `json:"plugin_ms,omitempty"`
	// NetMs: the wire, both directions, for THIS STEP's request-half evaluate.
	//
	// ⚠️ It rides the step/response because a round trip is only known once it ends —
	// the request half's own row cannot carry it. The request half is the one in
	// front of the first token, which is why that is the half worth carrying.
	NetMs int64 `json:"net_ms,omitempty"`
	// SkewMs: this gateway's clock MINUS the runtime's (the NTP offset), signed.
	//
	// ⚠️ A DIAGNOSTIC AND NOTHING ELSE. Nothing corrects by it — a correction would
	// make every stored duration depend on a number that moves — it is here so the
	// next "is the customer's gateway seven hours behind?" is a reading rather than
	// an investigation.
	SkewMs int64 `json:"skew_ms,omitempty"`
}

// subjectOf assembles the per-request agent identity. The consumer IS the agent: one
// consumer credential, one agent row. One credential driving several harnesses at
// once stays ONE agent — the runtime surfaces that as a shadow-agent signal, not a
// reason to split the inventory here. All-empty is the key-only floor, where the
// runtime derives the agent from the API key.
func subjectOf(agentID, agentType, workspace, user string) identity {
	return identity{
		AgentID:        agentID,
		AgentType:      agentType,
		AgentWorkspace: workspace,
		AgentUser:      user,
	}
}

// deriveCtx is what every event of one proxied call shares.
type deriveCtx struct {
	subj   identity
	stepID string
	// Above this many bytes an inline media part is described instead of sent
	// (media.go, `media_max_bytes`). Carried here rather than passed to each
	// constructor so the two halves of a step cannot disagree about the cap.
	// 0 = send every body verbatim.
	mediaLimits mediaLimits
	// The downstream flow this request arrived on — see GuardEvent.Connection.
	// Resolved ONCE per request (the property read costs a host call) and
	// stamped by the one constructor below, so the two halves of a step and
	// every speculative/tail-hold path carry the same value.
	connection string
	// WHO STARTED IT, off the request headers — see GuardEvent.Initiator. Resolved
	// ONCE per request and stamped by the one constructor below, so the two halves
	// of a step cannot disagree about it.
	initiator string
	// WHERE THE CLIENT DIALLED — see GuardEvent.LlmEndpoint. Resolved ONCE per request
	// off `:authority` and stamped by the one constructor below.
	llmEndpoint string
	// WHEN ENVOY SAW THE REQUEST and when this plugin's hook ran — the two ends of
	// `transport.GwMs`, both on THIS process's clock. A zero `envoyAt` means the host
	// would not answer the property, and the field is then omitted rather than
	// guessed.
	envoyAt time.Time
	hookAt  time.Time
	// The request half's completed evaluate, filled by `onInputVerdict` and stamped
	// onto the RESPONSE event by the one constructor. Zero until that call returns —
	// which is why the request event never carries them.
	netMs  int64
	skewMs int64
	// The CLIENT's wire protocol, detected per request. Never a constant: it was
	// `openai.chat` for every event an old build sent, which made 693,197 stored
	// events unfalsifiable. v0.8 makes the field REQUIRED, which is why a request
	// whose protocol cannot be established sends no event at all (see the
	// unrecognised-body policy in main.go) — inventing an enum value here would be
	// the same lie at schema strength.
	protocol string
}

// event is the ONE constructor every GuardEvent goes through — which is why
// `Integration` is stamped here rather than at each call site: a second
// construction path is how a build id goes missing on one kind of event only.
func (d *deriveCtx) event(kind string, payload json.RawMessage) *GuardEvent {
	return &GuardEvent{
		Kind:        kind,
		StepID:      d.stepID,
		LLMProtocol: d.protocol,
		identity:    d.subj,
		Payload:     payload,
		Integration: integrationID(),
		Connection:  d.connection,
		Initiator:   d.initiator,
		LlmEndpoint: d.llmEndpoint,
		// ⚠️ HERE, like every other per-request fact, and for the same reason: a
		// second construction path is how a field goes missing on one kind of event
		// only. `PluginMs` is measured AT CONSTRUCTION, so it is this plugin's work up
		// to the moment the event existed — see the type.
		Transport: d.transportNow(),
	}
}

// transportNow renders what is measurable at the moment an event is built. Returns
// nil when nothing is — an absent object, never one full of zeros: a zero that means
// "not measured" and a zero that means "instant" must not be the same bytes.
func (d *deriveCtx) transportNow() *transport {
	t := transport{NetMs: d.netMs, SkewMs: d.skewMs}
	if !d.envoyAt.IsZero() && !d.hookAt.IsZero() {
		t.GwMs = msBetween(d.envoyAt, d.hookAt)
	}
	if !d.hookAt.IsZero() {
		t.PluginMs = msBetween(d.hookAt, time.Now())
	}
	if t == (transport{}) {
		return nil
	}
	return &t
}

/*
 * observeEvaluate records what ONE completed evaluate call says about the path
 * between this gateway and the runtime, for the REQUEST half of this step — the half
 * that sits in front of the first token, and the only half whose round trip has a
 * later event of its own to ride on.
 *
 * ⚠️⚠️ **THIS IS AN NTP EXCHANGE AND THE FORMULAS ARE NTP'S.** Four instants: this
 * process dispatched at `sentAt` and received at `recvAt`; the runtime received at
 * `t3` and answered at `t4`. Neither pair can be subtracted from the other — that is
 * a clock offset wearing a duration's name — but two same-clock differences
 * subtracted give the round-trip WIRE time with the offset cancelled:
 *
 *	delay = (recvAt − sentAt) − (t4 − t3)
 *	skew  = ((sentAt − t3) + (recvAt − t4)) / 2
 *
 * ⚠️ `skew` is written in the OURS-MINUS-THEIRS direction, which is NTP's offset
 * negated, because that is the direction the field is named in and the direction an
 * operator reads it in: POSITIVE means this gateway's clock is AHEAD of the
 * runtime's, which is what the 2026-08 lab box was by 2.1 seconds. Flipping the sign
 * here without flipping the field's documentation would make the one number whose
 * entire content is its sign say the opposite of what it means.
 *
 * ⚠️ `delay` does NOT split into outbound and inbound. Halving it assumes a
 * symmetric path, which is an assumption and not a measurement, so it is not done
 * here and must not be done downstream.
 *
 * ⚠️ A NEGATIVE delay means the runtime reported spending longer than this whole
 * call took — a broken measurement on one side, never a fast network — and it
 * answers 0 = NOT MEASURED rather than a number somebody would plot.
 */
func (d *deriveCtx) observeEvaluate(sentAt, recvAt time.Time, v verdict) {
	t3, t4 := v.Timing()
	if t3.IsZero() || t4.IsZero() || sentAt.IsZero() || recvAt.IsZero() {
		return
	}
	delay := recvAt.Sub(sentAt) - t4.Sub(t3)
	if delay < 0 {
		return
	}
	d.netMs = delay.Milliseconds()
	d.skewMs = ((sentAt.Sub(t3) + recvAt.Sub(t4)) / 2).Milliseconds()
}

// msBetween is a non-negative millisecond span. A negative one is a clock that moved
// under us (wall-clock adjustment, or a host property from a different clock than
// `time.Now`), and the honest answer to that is 0 = not measured, never a negative
// duration in a UInt32 column.
func msBetween(from, to time.Time) int64 {
	ms := to.Sub(from).Milliseconds()
	if ms < 0 {
		return 0
	}
	return ms
}

// requestEvent is the step's first half: the provider request body, verbatim —
// except for an oversized inline media part, which is described rather than sent
// (media.go). The body FORWARDED to the model is untouched either way.
func requestEvent(d *deriveCtx, rawBody []byte) *GuardEvent {
	reported, _ := elideMedia(rawBody, d.mediaLimits)
	return d.event(kindStepRequest, json.RawMessage(reported))
}

// requestEventTimed is requestEvent plus the one wall-clock fact the request half
// can carry: when this gateway saw it (`timing.received_at`). Spliced by the same
// byte insertion the response half uses — see spliceTiming for why a re-marshal
// would move every span offset.
//
// ⚠️ This is NOT the event's timestamp, and the wire deliberately has no such
// field (v0.8). It is one END of a duration whose other end — the PREVIOUS step's
// `timing.completed_at` — this same process stamped, so the pair measures the
// agent's tool-execution gap with the clock skew cancelled out. A runtime that
// ordered events by it would be ordering by a clock it cannot audit.
func requestEventTimed(d *deriveCtx, rawBody []byte, receivedAt time.Time) *GuardEvent {
	t := &canonicalTiming{ReceivedAt: receivedAt.UTC().Format(time.RFC3339Nano)}
	reported, _ := elideMedia(rawBody, d.mediaLimits)
	return d.event(kindStepRequest, json.RawMessage(spliceTiming(reported, t)))
}

// responseEvent is the step's second half for a buffered reply: the provider
// response body, verbatim.
func responseEvent(d *deriveCtx, rawBody []byte) *GuardEvent {
	reported, _ := elideMedia(rawBody, d.mediaLimits)
	return d.event(kindStepResponse, json.RawMessage(reported))
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
	reported, _ := elideMedia(rawBody, d.mediaLimits)
	return d.event(kindStepResponse, json.RawMessage(spliceTiming(reported, timing)))
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
	// ReceivedAt is the REQUEST half's only endpoint: when this gateway saw the
	// request. It exists so a runtime can measure the gap between one step's reply
	// and the next step's request — the agent's own tool-execution time — WITHOUT
	// subtracting one clock from another. Both endpoints are then stamped here, by
	// one process, so a skew against the runtime's clock cancels instead of
	// accumulating. ⚠️ It is a DURATION ENDPOINT, never an ordering key: a runtime
	// orders events by its own derived coordinates (`step_id` and what it derives
	// from it), because nothing bounds how wrong a producer's clock can be.
	ReceivedAt   string `json:"received_at,omitempty"`
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
