# Overview

This document uses the keywords MUST, SHOULD, MAY as defined in RFC 2119.

## The layer model

**OGR models agent traffic the way the layered network model models packets,
and this model is the protocol's foundational concept.** It has two axes — the
same two a firewall has: **entities** (the parties, which persist) and a
**traffic stack** (the activity, every unit an episode with a beginning and an
end). An integration sees one GuardEvent at a time, the way a firewall sees
one IP packet; the runtime reassembles the layers above it and reads the
layers below it out of the payload.

The traffic stack, numbered like the network stack it mirrors:

| # | Layer | Network analogue | One unit is |
|---|---|---|---|
| **L6** | **Session** | — (this domain's own layer) | One conversation. |
| **L5** | **Turn** | — (this domain's own layer) | One instruction → quiescence: opens when user words arrive, closes when the agent stops. 1-based. |
| **L4** | **Step** | transport | One model call inside a turn: everything sent to the model, everything it returned, and every tool call it asked for. 1-based within its turn. |
| **L3** | **Event** | **network — the packet** | One `GuardEvent`: half a step, **the only layer on the wire**. Header (kind, `step_id`, the identity four-tuple) + payload (the provider body). |
| **L2** | **Call** | link | One tool call inside a step's response, keyed by the provider's tool-call id. Its result arrives in a LATER step's request and is paired by that id; the call belongs to the step that issued it. |
| **L1** | **Exec** | physical | One real execution on a machine. **Named by the model, not carried by the contract**: no current integration observes it, and the wire has no exec kinds. It exists because the gap between what a call claims and what an exec does is what agent security is about. |

L1–L4 track the pragmatic TCP/IP layers. Above transport, networking has only
"application", because network applications share no structure — but agent
traffic *is* a dialogue with stable structure, so **Turn and Session are this
domain's own layers**, defined here rather than borrowed. (This is deliberate:
OSI's session and presentation layers are the ones practice discarded; OGR
does not map its upper layers onto them by name.)

The entity axis, in the same firewall reading:

| Entity | Network analogue | On the wire |
|---|---|---|
| **Tenant** | the administrative boundary | the API key (never the payload) |
| **Workspace** | security zone — one zone, one policy set | `agent_workspace` |
| **Agent** | host / endpoint | `agent_id` (+ `agent_type`, `agent_user`) |

**An agent is an endpoint, not a layer.** Every stack unit is an episode;
an agent persists with zero traffic — sessions *belong to* it the way TCP
connections belong to a host. It is **addressed** by the identity four-tuple
every event header carries, and discovered from traffic the way hosts are
inventoried from packets.

The observed plane is **LLM messages**. Conversation and tool calls are not two
different vantage points — they travel together in the same provider
request/response bodies, and one step's two halves are exactly what an
integration can hold and forward. (Observing L1 directly — real process
execution, network and filesystem behavior underneath the agent — is reserved
for a future major version of the contract.)

**The ledger is the runtime's job, not the wire's.** An integration
declares NO coordinates: it names each model call with a `step_id` it minted,
and the runtime reconstructs everything above that — sessions by
conversation-prefix chaining (re-attaching across a harness's context
compaction), turns by instruction boundaries and idle timeout, steps by
arrival. The one coordinate on the wire is `step_id`, because the one fact a
runtime cannot derive under concurrency is which request and response were the
same model call. A firewall does not ask packets which connection they belong
to — coordinates a sender could declare are coordinates a sender could get
wrong.

OGR inserts a **decision** at the two moments an integration is holding
something it can still refuse: before the request reaches the model, and after
the response arrives but before the agent acts on it. The integration packages
what it holds as a [`GuardEvent`](guard-event.md), and asks a **runtime** (a
Policy Decision Point) for a [`Verdict`](verdict.md) — `allow` or `block`, with
findings saying what was found and where, and redaction spans when content must
be transformed in place.

```
                       step/request                    step/response
 agent loop ──────────────▶│                                │
   one model call          │  evaluate ──▶ runtime ──▶ verdict
   (one step_id)           ▼                                ▼
                     model call                    execute tool calls
```

## The layer model in span vocabulary (non-normative)

Most agent harnesses are already instrumented with **tracing spans** —
OpenTelemetry's GenAI semantic conventions, or a framework dialect of them
(OpenInference, and the trace/observation models the hosted tracing vendors
build on it). That vocabulary and this one describe the same traffic, so the
correspondence is worth stating exactly. This section is **informative**: no
part of the wire contract depends on it, and an integration is never required
to emit or consume spans.

⚠️ Two unrelated meanings of one word: a **tracing span** is a timed operation
in a trace; a Verdict's [`modifications.spans`](verdict.md#modifications) are
character offset ranges in a text. This section means the first.

| # | OGR layer | OTel GenAI span | Correspondence |
|---|---|---|---|
| **L6** | **Session** | *no span* — the `gen_ai.conversation.id` attribute that groups traces | Same unit. A harness records the id only when it already holds one; OGR **derives** the session and takes the harness's id, when it has one, as `session_hint` — a grouping signal, not authority. |
| **L5** | **Turn** | the `invoke_agent` span — usually a trace root | Same unit when the harness starts one invocation per user instruction. Nothing in the span model *requires* that, so the boundary is the harness's; OGR's is derived from the traffic. |
| **L4** | **Step** | the inference span — `chat {model}`, `gen_ai.operation.name = chat` | **Exactly 1:1.** One model call, request through full response, retries included. The cleanest anchor between the two models. |
| **L3** | **Event** | *no span* — a span EDGE | `step/request` is the inference span's start, `step/response` its end; the two payloads are what `gen_ai.input.messages` / `gen_ai.output.messages` carry (opt-in there, mandatory here — it IS the event). |
| **L2** | **Call** | the `execute_tool` span | Same unit, different placement: OGR attaches the call to the step that ISSUED it and pairs the result back from the next step's request; a tracer gives it its own span under the agent invocation, alongside the inference spans. |
| **L1** | **Exec** | *no span in the GenAI conventions* | What the tool process actually did. Ordinary (non-GenAI) spans may cover part of it; neither model claims to see it from the model plane. |

The entity axis, same reading:

| OGR | Span vocabulary |
|---|---|
| Tenant | not modeled — backend tenancy of the trace store (OGR: the API key, never the payload) |
| Workspace | not modeled — nearest neighbor is the resource attribute `deployment.environment.name` |
| Agent | `gen_ai.agent.id` / `gen_ai.agent.name` → `agent_id` / `agent_type` |
| (the human) | `user.id` → `agent_user` |

**Three differences that are not vocabulary.** They are why OGR does not simply
consume spans:

1. **A span is an interval; a GuardEvent is a half.** A span is written when its
   operation *ends* — after the model has answered, after the tool has run.
   OGR's two moments are the ones where something is still held and can still
   be refused: before the request reaches the model, and after the response
   arrives but before the agent acts on it. A span cannot block, so a step is
   two events rather than one record.
2. **A span declares its coordinates; a GuardEvent declares one.** `trace_id`,
   `span_id` and `parent_span_id` are producer-authored — and a producer that
   can declare a flow can get the flow wrong. The wire keeps `step_id` only,
   because pairing the two halves of one model call under concurrency is the
   one fact a runtime cannot derive; sessions, turns and step numbers are
   derived server-side.
3. **Telemetry is best-effort and sampled; enforcement is neither.** Dropping
   spans is normal operation; a dropped guard event is an unjudged model call.
   The same asymmetry governs content: message capture is opt-in for a tracer
   and unconditional here.

A fourth difference is shape. A trace is an open-ended tree — any framework may
nest whatever spans it likes — while this stack is six fixed layers, so the same
traffic from two different harnesses lands on the same coordinates.

**If your harness already emits spans**, three of the mappings are directly
useful when you write the integration:

- Mint `step_id` from the inference span's `span_id`. One span covers both
  halves of the step, which is exactly the pairing rule, and it makes every
  guard row joinable to the trace it came from.
- Send `gen_ai.conversation.id` as [`session_hint`](guard-event.md#session_hint).
- Send `gen_ai.agent.id` / `gen_ai.agent.name` / `user.id` as the identity
  four-tuple's `agent_id` / `agent_type` / `agent_user`, and name your
  instrumentation in [`integration`](guard-event.md#integration) the way an
  OTel instrumentation scope names itself.

What does NOT carry over: exporting spans to a collector is not an integration.
The evaluate call is synchronous and in the byte path — see
[the minimal integration](runtime-api.md#the-minimal-integration-your-own-agent).

Other dialects map through the same anchors — in OpenInference, span kind
`AGENT` ≈ turn, `LLM` ≈ step, `TOOL` ≈ call, `session.id` ≈ session,
`user.id` ≈ `agent_user`; its `GUARDRAIL` kind is where an OGR `evaluate` call
itself would appear if you traced it.

## One integration point, two vantage places

The same two POSTs serve a developer instrumenting their own agent loop and a
gateway proxying model traffic it does not understand. They no longer differ
in protocol — both forward the raw provider body they hold, both mint a
`step_id` per model call, both declare nothing else. The only difference left
is operational: who fills the [identity four-tuple](guard-event.md#identity)
(an agent asserts its own; a gateway asserts its authenticated caller's,
read off [request headers](runtime-api.md#at-a-gateway-the-four-tuple-arrives-as-headers))
and where the stream's held-back tail lives.

There is deliberately **no SDK layer**. The [Runtime API](runtime-api.md) is
the integration surface — one decision endpoint and one recipe — and every
integration, including the ones this repository ships, calls it directly.

## Two domains

OGR carries two risk domains under one contract:

- **safety.\*** — judged on *content*; typically blocked or redacted.
  Classifier-heavy.
- **security.\*** — judged on *actions and data flow*: what a tool call is
  about to do, whether an instruction arrived through data rather than from
  the user. Policy-heavy.

The category vocabulary is the [taxonomy](taxonomy.md).

## What OGR standardizes vs. leaves competitive

| OGR core (neutral) | Vendor / deployer (competitive) |
|---|---|
| event & verdict contract | detection mechanism (config rules **or** model/classifier) |
| the layer model (session/turn/step derived server-side) | detection quality, coverage, latency, freshness |
| composition meta-policy *mechanism* | which detectors to subscribe to and how to weight them |
| risk taxonomy (category IDs) | thresholds, what counts as unsafe for a use case |

A `Verdict` carries a `provider` field precisely so a runtime can attribute,
meter, and benchmark each detector's contribution.
