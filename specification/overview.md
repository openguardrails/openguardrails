# Overview

This document uses the keywords MUST, SHOULD, MAY as defined in RFC 2119.

## The model

An **agent** works in a loop: it takes an instruction, calls a model, executes
the tool calls the model asked for, feeds the results back, and calls the model
again — until it has nothing left to do. OGR names that loop the way agent
harnesses themselves do:

| Object | Definition |
|---|---|
| **Session** | One conversation. Sessions form a tree: a subagent's session names its parent. |
| **Turn** | One instruction → quiescence: opens when user words arrive, closes when the agent stops. 1-based. Closes with a **reason** (`completed`, `max_tokens`, `blocked`, `aborted`, `error`). |
| **Step** | One model call inside a turn: everything sent to the model, everything it returned, and every tool call it asked for. 1-based within its turn. |
| **Call** | One tool call inside a step's response, keyed by the provider's tool-call id. Its result arrives in a LATER step's request and is paired by that id. |

The observed plane is **LLM messages**. Conversation and tool calls are not two
different vantage points — they travel together in the same provider
request/response bodies, and one step's two halves are exactly what an
integration can hold and forward. (A lower plane — observing real process
execution, network and filesystem behavior underneath the agent — is out of
scope for this version of the contract.)

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
   turn N, step M          │  evaluate ──▶ runtime ──▶ verdict
                           ▼                                ▼
                     model call                    execute tool calls
```

## Two integration points

The same contract serves two vantage points. They differ ONLY in who knows the
coordinates:

- **Agent-direct** — a plugin inside a harness, or a developer building a
  harness who calls the runtime API at the loop's seams. The integration OWNS
  the loop, so it **declares** `session_id`, `turn` and `step` on every event,
  and reports each turn's close (`turn/end`) with its reason.
- **Gateway** — an LLM proxy (reference integration: Higress) that sees one
  stateless model call at a time. It declares nothing; the runtime **derives**
  session, turn and step server-side and echoes them on the verdict.

Declared always wins; derivation is the fallback for vantage points that cannot
know. The [`attribution`](verdict.md) field on every verdict says which answer
the caller got.

There is deliberately **no SDK layer**. The [Runtime API](runtime-api.md) is
the integration surface — two POST endpoints and two recipes — and every
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
| the session/turn/step/call model | detection quality, coverage, latency, freshness |
| composition meta-policy *mechanism* | which detectors to subscribe to and how to weight them |
| risk taxonomy (category IDs) | thresholds, what counts as unsafe for a use case |

A `Verdict` carries a `provider` field precisely so a runtime can attribute,
meter, and benchmark each detector's contribution.
