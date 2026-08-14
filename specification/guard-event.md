# GuardEvent

A `GuardEvent` is the unit an integration point submits to the runtime.
Keywords per RFC 2119.

The MUST set is deliberately tiny: **`kind` + `payload`** is a complete,
conformant event. Everything else refines attribution or coordinates, and the
runtime has a defined fallback for each absence. The minimal integration is an
API key and two fields.

## Kinds

An agent's loop runs in [steps](overview.md#the-model) — one model call each.
An event is one HALF of a step, observed at the moment the integration can
still refuse it, plus one lifecycle mark:

| `kind` | Emitted | `payload` |
|---|---|---|
| `step/request` | BEFORE the model call — holding what is about to be sent | the untouched provider request body (with `llm_protocol` as a hint), or the [canonical shape](#canonical-payloads) |
| `step/response` | AFTER the model answers, BEFORE the agent acts on it | the untouched provider response body, or the canonical shape |
| `turn/end` | when a loop-owning integration closes a turn | `{ "reason": "completed" \| "max_tokens" \| "blocked" \| "aborted" \| "error", "error"?: "..." }` |

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
- **`turn/start` deliberately does not exist.** It is derivable — the first
  `step/request` at a new turn number. `turn/end` is not derivable
  (quiescence is invisible until declared or timed out), which is why it is
  the one lifecycle mark in the vocabulary. Only loop-owning integrations can
  send it; a runtime closes undeclared turns by idle timeout.

**Forward the raw body.** An integration that holds a provider
request/response does not decompose anything — it sends the body it holds.
The RUNTIME normalizes: the new user words, the tool outcomes being fed back,
the model's prose, its reasoning, every tool call it asks for, and the
declared tool inventory (whose *definitions* are themselves an attack
surface — description injection, rug-pulls — judged from the `tools` array
where they already travel). `llm_protocol` (`openai.chat` |
`openai.responses` | `anthropic.messages`) is a hint; a runtime SHOULD also
detect the protocol from the body shape.

### Canonical payloads

An integration that does not hold a provider body (a harness with its own
message format) sends the canonical shape directly:

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

`usage` and `timing` are optional and worth sending: both vantage points have
them for free (the response body carries usage; the integration observes
time-to-first-token itself), and they power per-step cost and latency
analytics downstream.

The wire is deliberately STATELESS and repetitive — every `step/request`
carries the full conversation, exactly as the provider protocol does. A
runtime is expected to deduplicate at ingress (each message stored once, per
session); the network cost is accepted in exchange for an integration that
needs no state and no session affinity.

## Coordinates

| Field | Req | Description |
|---|---|---|
| `session_id` | SHOULD (loop-owning) | The producer's session. Absent, the runtime derives sessions itself and echoes the result on the Verdict. |
| `turn` | MAY | 1-based turn index within the session. |
| `step` | MAY | 1-based step index within the turn. |
| `step_id` | MAY | Producer-minted opaque id binding the two events of ONE model call. A gateway mints one per proxied call; a producer stamping `turn`+`step` MAY omit it. |
| `parent_session_id` | MAY | The spawning session, when this agent is a subagent. Each child reports its OWN session; the tree is the delegation record. |

**Declared beats derived.** An integration that owns its loop stamps the
trio on every event — that is the whole difference between the two
[integration points](overview.md#two-integration-points). A gateway stamps
nothing and the runtime reconstructs: sessions by conversation-prefix
chaining, turns by instruction boundaries, steps by arrival. The verdict's
`attribution` field says which happened. A runtime MUST honor a declared
trio and MUST NOT re-derive over it.

Known limitation of derivation, stated so nobody rediscovers it: a harness
that COMPACTS its context breaks the prefix-append assumption (request N+1
is no longer request N plus new messages), so a derived session splits at
the compaction point. Declaring `session_id` avoids this entirely.

## Identity

| Field | Req | Description |
|---|---|---|
| `agent_id` | SHOULD | The acting agent, unique within the organization. Absent, derived from the API key ([identity floor](#the-api-key-is-the-identity-floor)). |
| `agent_type` | SHOULD | What kind of agent (`hermes`, `openclaw`, `claude-code`, or the deployment's own product name). A label, not an identity — see [one `agent_id`, one agent](#one-agent_id-one-agent). Self-declared on the agent-direct path; a runtime MAY infer it (e.g. from the system prompt) on the gateway path. |
| `agent_workspace` | MAY | The named group of AGENTS this one belongs to. Absent, the API key's workspace. |
| `agent_owner` | MAY | The agent's builder / responsible party. An attribute, never a policy boundary. |
| `agent_user` | MAY | Who is using the agent THIS session. Absent, every session is one user. |

Behind a gateway that authenticates its callers with per-caller credentials,
the authenticated caller id is the natural `agent_id`; `agent_workspace` is
an agent grouping the operator maintains (e.g. a consumer-group header) —
never a human org chart, never a tenant.

### The API key is the identity floor

The identity fields degrade gracefully. The minimum conformant integration
sends only the organization API key and no identity fields at all: the
runtime MUST then derive `agent_id` from the key (one key, one default
agent), place the agent in the key's workspace, and treat every session as
the same single user. Each field an integration can assert refines that
picture; none is a precondition for coverage.

### One `agent_id`, one agent

`agent_id` names the agent; `agent_type` merely describes it. When events
share an `agent_id` but disagree on `agent_type` — one credential driving
hermes, openclaw, and claude-code at once — a runtime MUST keep them as ONE
agent (the id is the identity) and SHOULD surface the disagreement as a
**shadow agent** signal: several agents hiding behind one identity is a
usage error worth an operator's attention, not a reason to split the
inventory.

### `agent_owner` and `agent_user` are attributes, not boundaries

Identity and placement — `agent_id` and `agent_workspace` — decide where an
event lands and which policy set judges it. Owner and user *describe*: who
is accountable for the agent, who a session serves. They belong on the agent
inventory and the session record, for accountability and per-user analytics;
a runtime MUST NOT let either select configuration.

⚠️ **Every identity field is a CLAIM**, bounded by the channel: resolved only
within the tenant the channel credential proves (`agent_workspace` names a
workspace inside that tenant, never the tenant itself).

## Remaining fields

| Field | Req | Description |
|---|---|---|
| `ogr_version` | MAY | Spec version, e.g. `"0.7"`. Absent = the current version. |
| `timestamp` | SHOULD | RFC 3339 / ISO 8601 UTC — when the unit was OBSERVED. Absent = the runtime's receive time; only buffered/replayed events need it explicitly. |
| `integration` | SHOULD | The reporting integration and build, e.g. `"ogr-higress/0.4.1"`, `"dsh-plugin/0.1.0"`. For heartbeats, fleet coverage, and triaging a bad rollout. |
| `llm_protocol` | MAY | Which provider protocol a raw payload body speaks. |

All fields are FLAT, top-level, snake_case; objects are reserved for
inherently structured data (`payload`).

There is **no `event_id` on the request**. Identifiers are the runtime's job:

### Identifiers are born at the runtime

The runtime MUST assign every accepted event a unique, time-ordered
**`event_id`** at ingress and return it to the caller — on the
[`Verdict`](verdict.md) for `/v1/evaluate`, in the per-element `results` row
for `/v1/ingest` (order preserved). A client that wants to reference or query
an event uses the returned id; it never mints one. There is **no request
deduplication**: a client that retries a timed-out call MAY produce a
duplicate record, which observability data tolerates.

## Example — gateway path (raw body, nothing declared)

```json
{ "kind": "step/request", "llm_protocol": "openai.chat",
  "step_id": "hg-7f3a",
  "integration": "ogr-higress/0.4.1",
  "agent_id": "consumer-alice",
  "payload": { "model": "gpt-5", "messages": [ ... ], "tools": [ ... ] } }
```

The runtime derives session/turn/step and echoes them on the verdict with
`"attribution": "derived"`.

## Example — agent-direct path (canonical shape, coordinates declared)

```json
{
  "ogr_version": "0.7",
  "kind": "step/response",
  "session_id": "sess-01H9",
  "turn": 3,
  "step": 2,
  "agent_id": "build-agent-3",
  "agent_type": "my-harness",
  "integration": "my-harness-ogr/1.0.0",
  "payload": {
    "text": "Cloning the repo now.",
    "tool_calls": [
      { "id": "call_1", "name": "bash",
        "arguments": { "command": "git clone https://github.com/acme/app" } }
    ],
    "usage": { "input_tokens": 8120, "output_tokens": 64 },
    "timing": { "started_at": "2026-08-14T09:30:01Z",
                "first_token_at": "2026-08-14T09:30:01.4Z",
                "completed_at": "2026-08-14T09:30:02.1Z" }
  }
}
```

```json
{ "kind": "turn/end", "session_id": "sess-01H9", "turn": 3,
  "payload": { "reason": "completed" } }
```

## Example — minimal conformant event

```json
{ "kind": "step/request", "payload": { "messages": [ { "role": "user", "content": "hi" } ] } }
```

The runtime supplies everything else: `event_id` (returned on the verdict),
timestamp (receive time), the agent (derived from the API key), the session,
turn and step (derived), the workspace (the key's).

The normative JSON Schema is [`schema/guard-event.schema.json`](../schema/guard-event.schema.json).
