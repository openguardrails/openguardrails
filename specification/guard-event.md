# GuardEvent

A `GuardEvent` is the unit an integration point submits to the runtime.
Keywords per RFC 2119.

**Eight required fields, and exactly four optional.** v0.8 removed every knob a
producer could choose to skip: what a runtime can derive is not on the wire at
all (coordinates, timestamps, protocol versioning), and what only the producer
can know is mandatory — with the empty string as the explicit "I have nothing
to assert". An integration is an API key, eight required fields, and one
endpoint.

The optional fields are [`integration`](#integration) — the reporter's own
`name/version` — [`connection`](#connection), the reporter's opaque
downstream-flow id, [`session_hint`](#session_hint), the producer's own
name for the conversation this step belongs to, — since 1.4 —
[`redaction`](#redaction), what an integration masked on the host before this
step left it, — since 1.5 — [`initiator`](#initiator), who started the work
this step belongs to, — since 1.6 — [`llm_endpoint`](#llm_endpoint), the host
the agent pointed the model request at, and — since 1.8 —
[`transport`](#transport--where-the-time-went-18), where the time went on the way
here. Integrations SHOULD send each when they hold the fact. They are
OPTIONAL rather than required so the two ends of a deployment can roll forward
independently: making any of them mandatory would reject every build already
in the field, turning a diagnostic into an outage.

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
  "tools":    [ /* declared tool schemas — include when changed or first seen */ ],
  "timing":   { "received_at": "..." } }

// step/response
{ "text": "...", "reasoning": "...",
  "tool_calls": [ { "id": "call_abc", "name": "bash", "arguments": { ... } } ],
  "model": "...",
  "usage":  { "input_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0,
              "output_tokens": 0, "reasoning_tokens": 0 },
  "timing": { "started_at": "...", "first_token_at": "...", "completed_at": "..." } }
```

### `usage` and `timing`

Two per-step facts only the integration can supply, powering per-step cost
and latency analytics downstream:

- **`timing`** — wall-clock facts the byte path observes. On `step/response`,
  `{started_at, first_token_at?, completed_at}` (`started_at` is the
  request's release upstream; a buffered reply omits `first_token_at`). On
  `step/request`, one endpoint and one only: `{received_at}`, when the
  integration saw the request. On a CANONICAL payload it is the ordinary
  `timing` field; on a RAW provider body the integration MAY add it as a
  top-level `timing` key — inserted into the body's own bytes, never via a
  re-serialization, so span offsets keep indexing the strings as
  transported. No provider protocol defines a top-level `timing`; if a body
  carries one, the integration MUST leave it alone.

  **`timing` is a set of DURATION ENDPOINTS, not the event's timestamp — and
  a runtime MUST NOT order events by it.** The wire carries no event
  timestamp (v0.8): coordinates and ordering are the runtime's, derived from
  `step_id`, because nothing bounds how wrong a producer's clock can be and
  the receiving end cannot audit it. What these fields are FOR is arithmetic
  between two instants **the same process stamped** — `completed_at −
  started_at` is the generation, and the next step's `received_at −` this
  step's `completed_at` is the agent's own tool-execution gap. Within one
  clock a skew cancels; across two it accumulates, so a runtime measuring
  either span against its OWN receive time is measuring the delivery path as
  well. This is why `received_at` is worth sending and an event-level
  `timestamp` is not: one is half of a difference, the other is a claim
  about when something happened that the runtime would have to trust.
- **`usage`** — a raw body carries the provider's own accounting and needs
  nothing added. A canonical (stream-reassembled) payload SHOULD carry the
  canonical counters transcribed from the stream, and MUST omit the field
  rather than report zeros when the provider reported nothing — an
  integration holds no tokenizer, and absence is the honest value. For
  protocols where a stream reports usage only on request (`openai.chat`'s
  `stream_options.include_usage`), an enforcing integration MAY opt the
  request in, and then MUST withhold the resulting usage-only frame from a
  client that never asked for it.

### Media parts (OGR 1.1)

A provider body carries images, audio, video and documents in the protocol's
own shapes — a `data:` URI under `image_url.url`, Anthropic's
`source.{media_type,data}`, `input_audio.data`, `file.file_data`, or a
reference (an https URL, a provider `file_id`). **A runtime MUST treat all of
it as UNJUDGED content**: it is not text, no guardrail defined in this
specification reads it, and a verdict says nothing about it. What a runtime
does with the bytes — store them, expire them on their own clock, show them to
an operator — is its own business.

An integration MAY **elide** an inline part rather than send it, and a large
one SHOULD be elided: a short video is tens of megabytes, and in an enforcing
deployment the caller waits while every one of those bytes crosses the wire to
be not-read. When an integration elides a part it MUST:

1. replace the value **in place, at its own path**, with the string
   `ogr-media:elided` — never remove the element, which would shift every
   later array index and silently re-target every span behind it;
2. describe what was there in a top-level **`_ogr_media`** array on the
   payload, one entry per elided part:

```jsonc
"_ogr_media": [
  { "path": "payload.messages.3.content.1.image_url.url",
    "kind": "image",              // image | audio | video | document | file
    "media_type": "image/png",    // omitted when the body named none
    "bytes": 41288304 }           // DECODED size of what was elided
]
```

3. elide **inline base64 only, never text.** The payload is what the runtime
   judges, so a producer that shortened a prompt would be blinding the
   detectors on exactly the largest requests. What makes eliding a blob safe
   is that nothing reads it.

`_ogr_media` is inserted the same way `timing` is — into the body's own bytes,
never by re-serializing it — and only when at least one part was elided. Every
field in it is a producer CLAIM: it describes what the integration saw and
asserts nothing about the runtime's own storage. A runtime MUST NOT accept a
storage locator from it.

The body the integration FORWARDS to the model is never affected by any of
this: eliding is a property of the report, not of the traffic.

The wire is deliberately STATELESS and repetitive — every `step/request`
carries the full conversation, exactly as the provider protocol does. A
runtime is expected to deduplicate at ingress (each message stored once, per
session); the network cost is accepted in exchange for an integration that
needs no state and no session affinity.

## `step_id`: the one coordinate

| Field | Description |
|---|---|
| `step_id` | Producer-minted opaque id binding the `step/request` and `step/response` of ONE model call. A fresh random id per call (a UUID is fine); never reused. Opaque — no format is imposed — and at most 128 characters ([field bounds](#field-bounds)). |

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
string is the explicit "no assertion", never an error. Each is an opaque string
with a maximum length — 255, except `agent_type`'s 64 ([field
bounds](#field-bounds)):

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

## Field bounds

Every producer-written field on this event is an **opaque string**: there is no
character set, no prefix convention and no pattern, and a runtime MUST NOT
impose one. (`st-…` is one gateway's habit, not a format — the senders in this
repository mint bare UUIDs, hex strings and vendor call ids.) What each field
does have is a **maximum length**, and a runtime MUST refuse an event that
exceeds it rather than storing a shortened value:

| Field | Max | Required |
|---|---|---|
| `step_id` | 128 | yes, and non-empty |
| `agent_id` | 255 | yes (may be `""`) |
| `agent_workspace` | 255 | yes (may be `""`) |
| `agent_user` | 255 | yes (may be `""`) |
| `agent_type` | 64 | yes (may be `""`) |
| `integration` | 128 | optional |
| `connection` | 128 | optional |
| `session_hint` | 128 | optional |
| `initiator` | 32 | optional |
| `llm_endpoint` | 253 | optional |

Lengths count **Unicode code points**. The bounds are part of the schema
(`schema/guard-event.schema.json`) and were added to it in 2026-09; before that
the four-tuple and `step_id` carried none, and an integrator could only learn a
runtime's limit from a rejection in production.

⚠️ **A runtime MUST NOT truncate instead of refusing.** These values are stored
verbatim and correlated on — two `step_id`s sharing a prefix are two different
model calls, and a runtime that shortened them would merge the two steps into
one, silently and unrecoverably. Refusal is visible; truncation is not.

⚠️ **A bound is a floor for whatever stores the value.** `step_id` in particular
is kept verbatim by the runtime (as its step/guard correlation id), so every
column that holds one has to clear 128 — counted in BYTES where the store counts
bytes, which is 4× the bound unless the field is known to be ASCII in practice.
A store narrower than the wire fails at the far end of the request, after the
producer already has its verdict.

⚠️ Producers SHOULD stay well inside these: a UUID (32–36 characters) is the
recommended `step_id` and every shipped integration is inside 40. The bounds are
deliberately generous so that no conformant producer is squeezed, not an
invitation to compose ids out of several others.

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

## `connection`

`connection` names the DOWNSTREAM FLOW a request arrived on, as one opaque
string the integration mints — e.g. `<instance>#<connection ordinal>` for a
gateway, where the instance half keeps two replicas' ordinals apart. It MUST be
stable for the life of one client connection and MUST NOT be reused by another
process.

Why it exists: a gateway reassembles sessions from stateless requests, and the
body-level evidence can vanish wholesale — a harness that compacts or
tail-trims its history rewrites every prefix, and a bridge may strip every
session field the client asserted (both measured in production, 2026-08-19).
What survives all of that is transport: consecutive requests of one client
process ride one keep-alive connection. This field is the integration handing
that fact to the runtime — the same move a firewall makes when it reassembles a
stream from the four-tuple.

⚠️ **A connection names a PROCESS, not a conversation.** One desktop app can
run several conversations down one connection, and an L4 balancer in front of
the integration can pool many clients into one. A runtime MAY therefore use it
only as a corroborated, last-resort grouping signal — behind every
content-derived answer, refused outright when the flow maps to more than one
live candidate — and MUST NOT derive trust, authorization or policy selection
from it. Like `integration`, it is a self-declared label bounded only by the
credential that carried it.

## `session_hint`

`session_hint` is the producer's own name for the CONVERSATION this step
belongs to — an opaque string, stable for the life of one conversation,
different across two conversations the same producer runs at once. A harness
or SDK that holds a natural session id (nearly all do) SHOULD send it on
every event of that session, side calls and subagent calls included.

⚠️ **This is not v0.7's `session_id` coming back, and the name is different
on purpose.** Declared COORDINATES (session/turn/step) stay off the wire:
they were authority, they short-circuited derivation, and nothing bounds how
wrong a producer's bookkeeping is. A HINT is a grouping signal: the runtime
still owns the ledger — it derives turns and steps, orders by its own
assignment, and MAY decline the hint's grouping where its own evidence
contradicts it. What the hint answers is the one question content-derivation
provably cannot always answer (measured 2026-08-19): which conversation a
request belongs to after the harness has compacted or tail-trimmed its
history, and which conversation a side call (a safety check, a title
generation, a subagent) was made on behalf of.

A runtime MUST NOT treat it as authorization, policy selection, ordering, or
trust of any kind — the `integration` rule. It is scoped to the credential
that carried it: two tenants' identical hints never meet.

## `initiator`

`initiator` says WHO STARTED the work this step belongs to, in the cases where
the producer knows and the body does not say. Two values:

- **`scheduled`** — a scheduler started it. No person is present, so nothing
  can be escalated to one and nobody is reading the answer.
- **`spawned`** — another agent session started it. A person may still be at
  the root of the chain; this says only that the immediate caller was not one.

**ABSENT IS THE NORMAL CASE, AND IT IS NOT A CLAIM THAT A HUMAN IS PRESENT.**
A producer that cannot tell omits the field, and so does one whose own banner
already says it in the body — most harnesses announce a scheduled run in the
first line of the prompt, and a runtime reads that for itself. There is
deliberately **no `human` value**: nothing can prove a person was there, so a
runtime would have to ignore the claim, and a field whose commonest value must
be ignored teaches producers to send noise.

⚠️ **A runtime MUST accept an unknown value by IGNORING it**, never by
rejecting the event. The vocabulary may grow, and a producer one version ahead
must not have its traffic refused — the same argument that makes the field
optional in the first place.

⚠️ It is a CLAIM, per the [`integration`](#integration) rule: self-declared,
bounded only by the credential that carried it, and a **RECORD ONLY**. A
runtime MUST NOT derive authorization, policy selection, enforcement, or rate
limiting from it. What it buys is that a scheduled run is legible as one.

The motivating case is a harness whose scheduled runs carry **no in-band
marker at all**. Claude Code's cron injects the user's own prompt verbatim into
the session and declares the fact only out of band, in a request header
(`cc_workload=cron` in its billing-attribution header, `workload/cron` in its
User-Agent; its own source comments that header "Absent = interactive
default"). A gateway sitting in front of it can see that; the body cannot. Any
integration holding an equivalent fact — a cron runner invoking an SDK, a
harness plugin that knows why it woke up — SHOULD send it.

## `llm_endpoint`

`llm_endpoint` (OGR 1.6) is the HOST the agent pointed the model request at —
`host[:port]`, no scheme, path, userinfo or query:

```json
"llm_endpoint": "api.openai.com"
```

It answers *where did the agent dial*, not *who finally served it*. The
distinction decides what each integration reports:

- a **gateway** reports the `:authority` it RECEIVED — the address the client
  configured, before the gateway's own routing and any provider rewrite;
- an **agent-side plugin** reports the host of the URL it intercepted;
- an integration with no HTTP view (a hook that sees messages, not requests)
  sends nothing, and a runtime MUST NOT infer one.

What it is FOR is the credential ledger: a secret that sits in the context
goes wherever the request goes, and a request pointed at a host that is no
known model vendor and not the tenant's own is the one signal that names a
**relay** — a party that is neither the vendor nor the tenant, sitting on the
model channel, which nothing in the body can reveal.

⚠️ **A runtime MUST accept a malformed value by IGNORING it**, never by
rejecting the event: a bad claim about where the agent dialled is not a reason
to lose the event. The only refusal is the length bound (253, RFC 1035 plus a
port). A runtime SHOULD normalise the value to a lower-cased `host[:port]` and
MAY take the host out of a full URL a producer sent by mistake.

⚠️ It is a CLAIM, per the [`integration`](#integration) rule: self-declared,
bounded only by the credential that carried it, and a **RECORD ONLY**. A
runtime MUST NOT derive authorization, policy selection, enforcement or trust
from it. Absent is the whole installed base before 1.6.

## `transport` — where the time went (1.8)

`transport` (OGR 1.8) is what the integration can measure about the path a
request took to a verdict, so a first-token regression is attributable to a
LAYER rather than argued about:

```json
"transport": { "gw_ms": 3, "plugin_ms": 8, "net_ms": 80, "skew_ms": 2100 }
```

| Field | Meaning |
|---|---|
| `gw_ms` | the host had the request before the guard code did — filter chain, body buffering |
| `plugin_ms` | the guard code's own work, up to the moment it built this event |
| `net_ms` | the wire, BOTH directions, for the evaluate call this step's request half made |
| `skew_ms` | the integration's clock MINUS the runtime's, signed — a DIAGNOSTIC |

⚠️⚠️ **EVERY VALUE IS A DURATION MEASURED INSIDE ONE CLOCK, AND AN INTEGRATION
MUST NOT PRODUCE ONE ANY OTHER WAY.** The obvious implementation — stamp four
timestamps across the two parties and subtract the neighbours — yields one number
that spans two machines' clocks, and the error is not small: on a measured
deployment an integration's own stamps sat a steady 2.1 seconds from the
runtime's receive time on 2,997 of 3,000 events, on a host whose clock matched
its own machine to under a second. Reported as network, that is two seconds of
fiction in a latency board. This is the same rule [`timing`](#usage-and-timing)
states, applied to the delivery path instead of the generation.

`net_ms` is how that rule is kept while still measuring the wire: it is the
integration's OWN round trip minus the `responded_at − received_at` the runtime
reported in the [verdict's `timing`](verdict.md#timing--the-runtimes-own-two-instants-18)
— two same-clock differences subtracted, the NTP delay formula, no synchronised
clocks required. ⚠️ It does NOT decompose into outbound and inbound; an
integration MUST NOT report half of it as either.

⚠️ `net_ms` and `skew_ms` describe a call that ALREADY COMPLETED, so they ride
the `step/response` and describe that step's REQUEST half — the half in front of
the first token. A round trip cannot ride the event that started it. A one-sided
step carries neither, and an integration MUST NOT carry them across steps: they
would then name a call the reader cannot find.

⚠️ Absent fields and an absent object are both normal — an integration with no
view of a hop omits it. `0` is a measured zero; **an unmeasured hop is an ABSENT
key**, and a runtime MUST NOT read one as the other (a zero averaged into a
quantile is a hop that was never timed pulling every reader toward it).

⚠️ It is a CLAIM, per the [`integration`](#integration) rule: self-declared and a
**RECORD ONLY**. A runtime MUST NOT derive authorization, policy selection,
enforcement or trust from it — and MUST NOT correct any stored time by `skew_ms`,
which would make every recorded duration depend on a number that moves.

## `redaction`

`redaction` is the per-step report of an integration doing
[local redaction](local-redaction.md) (OGR 1.4) — masking secrets on the host
before the request left it, so the model, the runtime and everything between
them see `${OGR_SECRET_n}` where the credential was:

```json
"redaction": {
  "ruleset": "rs_9f2c1e0a7b3d4c5e8f1a2b3c4d5e6f70",
  "masked": [
    { "token": "${OGR_SECRET_3}", "rule": "entity_api_key/gitlab" }
  ]
}
```

- `ruleset` — the id of the ruleset the integration ran, exactly as
  [`GET /v1/rules`](runtime-api.md#get-v1rules) served it. The empty string
  means local redaction is on but no ruleset was ever obtained.
- `masked[]` — the tokens MINTED in this step, never values; at most 256
  entries. Each `token` matches `^\$\{OGR_[A-Z_]+_[0-9]+\}$`; each `rule` is a
  `check_id` or `check_id/pattern_id`, at most 128 characters.

Integrations doing local redaction SHOULD send it on every event. **Absent**
means the integration does not do local redaction or has it switched off; a
runtime MUST accept such an event and MUST draw no diagnosis from it.

⚠️ It is a **CLAIM, per the [`integration`](#integration) rule**: self-declared,
never an input to a decision. Nothing bounds what a caller reports it masked,
so a runtime MUST NOT derive trust, authorization or policy selection from it,
SHOULD verify that each reported token occurs in the body before counting it,
and MUST count it nowhere else. What it is FOR is a diagnosis: a token in
traffic is a success record and raises nothing, while a secret the runtime
still finds on a step carrying this report can be named — a stale ruleset, a
missed rule, or a shape no rule covers — instead of being a mystery.

## `sources` — what the untrusted content IS (1.10 DRAFT)

OPTIONAL, and the newest field to earn a place on the wire by the usual test:
**a runtime cannot derive it.** Everything else about trust it can. The
conversation arrives whole on every `step/request`, so the runtime already sees
which messages are system, which are the user's, and which are tool results —
and that is the whole of `trusted` / `user` / `untrusted`. A runtime MUST derive
those itself and MUST NOT require this field to do it.

What no payload reveals is what an untrusted string actually is. A tool result
is opaque: the runtime sees that a tool returned text, not that the text is an
email whose DMARC failed, nor who sent it. The producer holds that fact alone,
so it rides here — one entry per registered path:

```json
"sources": [
  { "path": "payload.messages.3.content",
    "channel": "email.inbound",
    "origin": "billing@vendor-example.com",
    "auth": { "spf": "pass", "dkim": "fail", "dmarc": "fail" } }
]
```

`path` resolves through the same registration table as
[`findings[].path`](verdict.md#findings); a path naming nothing in the payload is
dropped, never an error. `channel` is an open vocabulary — an unknown channel is
untrusted like any other and MUST NOT reject the event. `auth` is deliberately
untyped: it is the channel's own result, verbatim, and a runtime reads what it
recognises.

⚠️ **A CLAIM per the [`integration` rule](#integration), with one asymmetry that
matters more here than anywhere else: it may only ever LOWER trust.** A runtime
MUST NOT promote content on the strength of this field, and MUST reach the same
decision, or a stricter one, with every entry removed. `"dmarc": "pass"` asserted
by the process being guarded is worth exactly nothing — and unlike `integration`,
where a false label costs attribution, a false label here would cost the boundary
itself.

⚠️ **Absent is not a claim of trustworthiness.** Unlabelled content keeps the
trust its role implies; a tool result with no entry stays `untrusted`. A producer
that omits the field loses precision, never protection — which is what makes the
field safe to adopt incrementally.

The derivation and propagation rules this feeds, and the enforcement it enables,
are in [provenance](provenance.md). None of that is on the wire.

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

## Obligation results (OGR 1.2)

A `step/request` MAY carry `obligation_results[]` — what the enforcement point did
about the [obligations](obligations.md) a previous verdict gave it, beside the
`tool_results` for the same calls.

⚠️ **SELF-DECLARED.** A PEP that called no scanner and reported `clean` is
byte-identical to one that called and was told `clean`. A runtime MUST NOT treat a
reported result as verified and MUST NOT make it an input to authorization — the
same rule [`integration`](#integration) carries. Absent is the ordinary case and
means nothing was reported, which is a fact worth counting rather than an error
worth refusing.
