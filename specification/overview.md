# Overview

This document uses the keywords MUST, SHOULD, MAY as defined in RFC 2119.

## The model

An **agent** works in a loop: it takes an instruction, calls a model, executes
the tool calls the model asked for, feeds the results back, and calls the model
again — until it has nothing left to do. OGR names that loop the way agent
harnesses themselves do:

| Object | Definition |
|---|---|
| **Session** | One conversation. |
| **Turn** | One instruction → quiescence: opens when user words arrive, closes when the agent stops. 1-based. |
| **Step** | One model call inside a turn: everything sent to the model, everything it returned, and every tool call it asked for. 1-based within its turn. |
| **Call** | One tool call inside a step's response, keyed by the provider's tool-call id. Its result arrives in a LATER step's request and is paired by that id. |

The observed plane is **LLM messages**. Conversation and tool calls are not two
different vantage points — they travel together in the same provider
request/response bodies, and one step's two halves are exactly what an
integration can hold and forward. (A lower plane — observing real process
execution, network and filesystem behavior underneath the agent — is out of
scope for this version of the contract.)

**The ledger is the runtime's job, not the wire's.** In v0.8 an integration
declares NO coordinates: it names each model call with a `step_id` it minted,
and the runtime reconstructs everything above that — sessions by
conversation-prefix chaining (re-attaching across a harness's context
compaction), turns by instruction boundaries and idle timeout, steps by
arrival. The one coordinate on the wire is `step_id`, because the one fact a
runtime cannot derive under concurrency is which request and response were the
same model call.

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
| the session/turn/step/call model (derived server-side) | detection quality, coverage, latency, freshness |
| composition meta-policy *mechanism* | which detectors to subscribe to and how to weight them |
| risk taxonomy (category IDs) | thresholds, what counts as unsafe for a use case |

A `Verdict` carries a `provider` field precisely so a runtime can attribute,
meter, and benchmark each detector's contribution.
