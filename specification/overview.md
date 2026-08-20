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
