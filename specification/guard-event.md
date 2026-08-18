# GuardEvent

A `GuardEvent` is the unit an integration point submits to the runtime.
Keywords per RFC 2119.

**Eight required fields, and exactly one optional.** v0.8 removed every knob a
producer could choose to skip: what a runtime can derive is not on the wire at
all (coordinates, timestamps, protocol versioning), and what only the producer
can know is mandatory — with the empty string as the explicit "I have nothing
to assert". An integration is an API key, nine fields, and one endpoint.

The single optional field is [`integration`](#integration) — the reporter's own
`name/version`. Integrations SHOULD send it. It is OPTIONAL rather than required
so the two ends of a deployment can roll forward independently: making it
mandatory would reject every build already in the field, turning a diagnostic
into an outage.

## Kinds

An agent's loop runs in [steps](overview.md#the-model) — one model call each.
An event is one HALF of a step, observed at the moment the integration can
still refuse it:

| `kind` | Emitted | `payload` |
|---|---|---|
| `step/request` | BEFORE the model call — holding what is about to be sent | the untouched provider request body |
| `step/response` | AFTER the model answers **whole**, BEFORE the agent acts on it | the untouched provider response body (stream-reassembled if streamed) |

Design rules the vocabulary enforces:

- **One event is one step half — never less.** A step's prose, its reasoning
  and ALL of its tool calls are one `step/response`; the fed-back tool
  results and the user's new words are one `step/request`. There is no kind
  left to shatter a step into fragments, because splitting a generation
  destroys the semantics a judge needs most: that the prose and the actions
  came from the same prompt.
- **Tool results are judged in the next request.** A call's result travels in
  the following `step/request` (that is where the wire puts it); the runtime
  pairs it with its call by the provider's tool-call id. No third content
  kind exists.
- **Turn lifecycle left the wire in v0.8.** `turn/end` is gone: the runtime
  closes turns itself — a new user instruction in a later request closes the
  previous turn, the raw body's own `finish_reason` reveals `max_tokens`, a
  block is the runtime's own act, and an idle timeout closes what nothing
  else did. The one cost is that "completed" and "aborted" are
  indistinguishable from outside, and v0.8 accepts that cost to keep the
  agent stateless.

**Forward the raw body.** An integration that holds a provider
request/response does not decompose anything — it sends the body it holds.
The RUNTIME normalizes: the new user words, the tool outcomes being fed back,
the model's prose, its reasoning, every tool call it asks for, and the
declared tool inventory (whose *definitions* are themselves an attack
surface — description injection, rug-pulls — judged from the `tools` array
where they already travel). The system prompt needs no special handling —
it is `messages[0]` of the body being forwarded, exactly as the provider
sees it.

### `llm_protocol`

Which protocol the payload speaks: `openai.chat` | `openai.responses` |
`anthropic.messages` | `canonical`. Required — the producer knows what it is
sending and says so; a runtime MAY still verify against the body shape and
reject a mismatch. An agent built on a normalizing client library (litellm
and most gateways normalize everything to the OpenAI chat shape) states the
shape it actually sends: `openai.chat`.

### Canonical payloads

`llm_protocol: "canonical"` is for the integration that does NOT hold a
provider body: a harness with its own internal message format, or a stream
judged after reassembly where no single raw body ever existed. The shape:

```jsonc
// step/request
{ "messages": [ /* the full conversation being sent */ ],
  "tools":    [ /* declared tool schemas — include when changed or first seen */ ] }

// step/response
{ "text": "...", "reasoning": "...",
  "tool_calls": [ { "id": "call_abc", "name": "bash", "arguments": { ... } } ],
  "model": "...",
  "usage":  { "input_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0,
              "output_tokens": 0, "reasoning_tokens": 0 },
  "timing": { "started_at": "...", "first_token_at": "...", "completed_at": "..." } }
```

### `usage` and `timing` on `step/response`

Two per-step facts only the integration can supply, powering per-step cost
and latency analytics downstream:

- **`timing`** — `{started_at, first_token_at?, completed_at}`, wall-clock
  facts the byte path observes (`started_at` is the request's release
  upstream; a buffered reply omits `first_token_at`). On a CANONICAL payload
  it is the ordinary `timing` field; on a RAW provider body the integration
  MAY add it as a top-level `timing` key — inserted into the body's own
  bytes, never via a re-serialization, so span offsets keep indexing the
  strings as transported. No provider protocol defines a top-level `timing`;
  if a body carries one, the integration MUST leave it alone.
- **`usage`** — a raw body carries the provider's own accounting and needs
  nothing added. A canonical (stream-reassembled) payload SHOULD carry the
  canonical counters transcribed from the stream, and MUST omit the field
  rather than report zeros when the provider reported nothing — an
  integration holds no tokenizer, and absence is the honest value. For
  protocols where a stream reports usage only on request (`openai.chat`'s
  `stream_options.include_usage`), an enforcing integration MAY opt the
  request in, and then MUST withhold the resulting usage-only frame from a
  client that never asked for it.

The wire is deliberately STATELESS and repetitive — every `step/request`
carries the full conversation, exactly as the provider protocol does. A
runtime is expected to deduplicate at ingress (each message stored once, per
session); the network cost is accepted in exchange for an integration that
needs no state and no session affinity.

## `step_id`: the one coordinate

| Field | Description |
|---|---|
| `step_id` | Producer-minted opaque id binding the `step/request` and `step/response` of ONE model call. A fresh random id per call (a UUID is fine); never reused. |

This is the single coordinate v0.8 kept, because it is the single fact a
runtime cannot derive: an agent running model calls concurrently (parallel
tool use, fan-out subagents) interleaves its requests and responses, and
arrival order stops pairing them. A `step_id` is a local variable in the
loop, not session state — minting it costs one line and no bookkeeping.

Everything above it is DERIVED, always: sessions by conversation-prefix
chaining (a harness that compacts its context is re-attached by the runtime
at the compaction point), turns by instruction boundaries and idle timeout,
step numbering by arrival. There is no declared/derived distinction left and
no `attribution` field to report one.

## Identity

The **four-tuple**. All four fields are required on every event; the empty
string is the explicit "no assertion", never an error:

| Field | Empty means | Description |
|---|---|---|
| `agent_id` | derived from the API key ([identity floor](#the-api-key-is-the-identity-floor)) | WHICH agent this is — unique within the organization; the key the inventory and policy resolution hang off. Example: `"invoice-bot"`. |
| `agent_type` | unlabeled | What KIND of agent — the harness or product name (`"langgraph"`, `"claude-code"`, `"my-harness"`). A label, not an identity — see [one `agent_id`, one agent](#one-agent_id-one-agent). |
| `agent_workspace` | the API key's workspace | The named GROUP of agents this one belongs to — one workspace, one policy set. Example: `"finance-agents"`. |
| `agent_user` | every session is one user | Who is USING the agent this session — changes per session or per request. Example: `"u-8232"`. |

Behind a gateway that authenticates its callers with per-caller credentials,
the authenticated caller id is the natural `agent_id`; `agent_workspace` is
an agent grouping the operator maintains (e.g. a consumer-group header) —
never a human org chart, never a tenant. Which HTTP headers carry the four
fields there, and which of them a client must never be allowed to set, is
[Runtime API § at a gateway](runtime-api.md#at-a-gateway-the-four-tuple-arrives-as-headers).

### The API key is the identity floor

The four-tuple degrades gracefully. An integration sending four empty
strings is still fully attributable: the runtime MUST derive `agent_id` from
the API key (one key, one default agent), place the agent in the key's
workspace, and treat every session as the same single user. Each field an
integration fills refines that picture; none is a precondition for coverage.
Requiring the fields while allowing them empty is deliberate: every
integrator answers the identity question explicitly instead of falling into
the floor by omission.

### One `agent_id`, one agent

`agent_id` names the agent; `agent_type` merely describes it. When events
share an `agent_id` but disagree on `agent_type` — one credential driving
several harnesses at once — a runtime MUST keep them as ONE agent (the id is
the identity) and SHOULD surface the disagreement as a **shadow agent**
signal: several agents hiding behind one identity is a usage error worth an
operator's attention, not a reason to split the inventory.

### `agent_user` is an attribute, not a boundary

Identity and placement — `agent_id` and `agent_workspace` — decide where an
event lands and which policy set judges it. `agent_user` *describes*: who a
session serves. It belongs on the session record, for per-user analytics; a
runtime MUST NOT let it select configuration.

### There is no `agent_owner`

Who is ACCOUNTABLE for an agent is not something a producer can assert. It was
a wire field until 2026-08-17 and is now removed outright, because the only
honest source for it is the runtime's own account directory:

- On the wire it was a **per-request, self-declared string** — as trustworthy as
  whichever route happened to inject the header, and re-assertable on every call.
  A runtime that trusted it could have ownership flipped by a config mistake; one
  that did not trust it was storing a field nobody read.
- Ownership is a **console concept with console consequences**: it decides who may
  read an agent's traffic. A permission cannot rest on a claim the caller makes
  about itself.

So a runtime SHOULD hold ownership as a link from the agent to an ACCOUNT it
already knows, assigned by an administrator. Nothing about that belongs on this
wire, and a producer sending an owner is asserting something it cannot know.

⚠️ **Every identity field is a CLAIM**, bounded by the channel: resolved only
within the tenant the channel credential proves (`agent_workspace` names a
workspace inside that tenant, never the tenant itself).

## What v0.8 removed, and where each job went

| Removed | The job moved to |
|---|---|
| `ogr_version` | the runtime adapts to the body it receives; producers never version-gate |
| `session_id` / `turn` / `step` | derived server-side, always |
| `parent_session_id` | gone with declared coordinates; sessions are flat on the wire |
| `timestamp` | the runtime's receive time |
| kind `turn/end` | runtime-side turn closing (instruction boundary, `finish_reason`, idle timeout) |

`integration` was removed here too and has been **restored as OPTIONAL** — see
below for what the heartbeat-only version could not answer.

## `integration`

`integration` names the reporter and its build as one string, `name/version`
(e.g. `ogr-higress/3.0.2`). The NAME is the identity — a rollout MUST NOT read
as a second integration — and the version rides along for triage.

Integrations SHOULD send it on every event. A runtime MUST accept an event that
omits it, and MUST NOT infer a reporter for one that does.

⚠️ It is a **self-declared label, not proof.** Nothing bounds what a caller
names itself, so it is exactly as trustworthy as the credential that carried it
and no more. A runtime MUST NOT derive trust, authorization or policy selection
from it.

### Why it is on the event and not only on the heartbeat

v0.8 moved the build id to the [heartbeat](runtime-api.md#post-v1heartbeat)
alone, on the reasoning that fleet coverage is a property of the REPORTER rather
than of any one event. That reasoning holds for coverage and fails for triage,
in two ways that are both silent:

- **A heartbeat is a separate channel with its own failure modes** — blocked
  egress, a misconfigured plugin, a worker whose timer never fires. It goes quiet
  exactly when a bad rollout is what you are trying to name, and the traffic
  itself carries nothing to fall back on.
- **Beats collapse.** A runtime that keys its liveness record on the integration
  NAME (which it must, so a rollout updates its row instead of minting a second)
  folds every deployment of that integration under one tenant into a single row.
  Two replicas on one build and a third on another produce one row whose version
  is whichever beat landed last — and the reader has no way to see that it is an
  aggregate.

On the event neither can happen: the string travels with the traffic it
describes, no other reporter can overwrite it, and stored events can be split by
build to compare behaviour across a rollout. The heartbeat's copy stays as the
liveness signal; the event's copy is the triage signal.

There is **no `event_id` on the request**. Identifiers are the runtime's job:

### Identifiers are born at the runtime

The runtime MUST assign every accepted event a unique, time-ordered
**`event_id`** at ingress and return it on the [`Verdict`](verdict.md). A
client that wants to reference or query an event uses the returned id; it
never mints one. There is **no request deduplication**: a client that
retries a timed-out call MAY produce a duplicate record, which observability
data tolerates.

## Example — one complete event

```json
{
  "kind": "step/response",
  "step_id": "8c2f1a0e77b04d5b",
  "agent_id": "invoice-bot",
  "agent_type": "my-harness",
  "agent_workspace": "finance-agents",
  "agent_user": "u-8232",
  "llm_protocol": "openai.chat",
  "payload": {
    "id": "chatcmpl-9x",
    "model": "gpt-5",
    "choices": [ { "index": 0, "finish_reason": "tool_calls", "message": {
      "role": "assistant", "content": "Cloning the repo now.",
      "tool_calls": [ { "id": "call_1", "type": "function", "function": {
        "name": "bash", "arguments": "{\"command\": \"git clone https://github.com/acme/app\"}" } } ] } } ],
    "usage": { "prompt_tokens": 8120, "completion_tokens": 64 },
    "timing": { "started_at": "2026-08-15T09:30:01Z",
                "first_token_at": "2026-08-15T09:30:01.4Z",
                "completed_at": "2026-08-15T09:30:02.1Z" }
  }
}
```

The payload is the provider's response body as transported (plus the
integration-inserted `timing`); the runtime does all decomposition. A
gateway's event looks identical — it fills the four-tuple from its own
authenticated caller instead of from config.

The normative JSON Schema is [`schema/guard-event.schema.json`](../schema/guard-event.schema.json).
