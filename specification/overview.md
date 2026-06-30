# Overview

This document uses the keywords MUST, SHOULD, MAY as defined in RFC 2119.

## The model

An **agent** does work by emitting actions: it sends messages to an LLM, it
registers tools and MCP servers, it loads skills, it calls tools, and — often
inside a **sandbox** — it executes commands, opens network connections, and
touches files.

OGR inserts a **decision** at each of these moments. An **interception point**
observes an action, packages it as a [`GuardEvent`](guard-event.md), and asks a
**runtime** (a Policy Decision Point) for a [`Verdict`](verdict.md). The runtime
fans the event out to one or more **detectors** (vendor capabilities), then
**composes** their verdicts into a single decision the interception point
enforces.

```
 action ──▶ interception point ──GuardEvent──▶ runtime ──┬─▶ detector A ─┐
                    ▲                                     ├─▶ detector B ─┤
                    │                                     └─▶ detector C ─┘
                 Verdict ◀──────── composition ◀──────────────────────────┘
```

## Three observation altitudes

The same logical action is often observable at more than one point. OGR treats
these as **defense in depth** and correlates them with a shared
[`guard_id`](provenance-and-context.md#guard-context-propagation).

| Altitude | `observation_point` | Sees | Trust property |
|---|---|---|---|
| Gateway (AI gateway / LLM proxy) | `gateway` | messages, tool/MCP/skill definitions, tool calls & results — normalized across LLM protocols | richest intent + provenance |
| Agent hook | `agent_hook` | lifecycle events (pre/post tool, pre/post model) inside the agent loop | cheap, in-process |
| Sandbox | `sandbox` | real `execve`, network, filesystem behavior | adversary-proof, agent can't bypass |

A runtime MUST be able to ingest events from any altitude and SHOULD correlate
events that share a `guard_id` so a single logical action yields a single
enforced decision.

## Two domains

OGR carries two risk domains under one contract:

- **safety.\*** — judged on *content*; actions are typically `block`, `redact`,
  `modify` (regenerate). Classifier-heavy.
- **security.\*** — judged on *actions and data flow*; actions are typically
  `block`, `require_approval`, `modify` (constrain). Policy + provenance heavy,
  and frequently enforceable **statically** by compiling policy into the
  sandbox (seccomp / landlock / egress allow-lists) in addition to the runtime
  check.

Compiling a security policy into a sandbox and also checking it at runtime is
not redundant: the static floor is hard, coarse, and zero-latency; the runtime
ceiling is semantic, fine, and provenance-aware.

## What OGR standardizes vs. leaves competitive

| OGR core (neutral) | Vendor / deployer (competitive) |
|---|---|
| event & verdict contract | detection mechanism (config rules **or** model/classifier) |
| provenance & guard-context | detection quality, coverage, latency, freshness |
| composition meta-policy *mechanism* | which vendors to subscribe to and how to weight them |
| risk taxonomy (category IDs) | thresholds, what counts as unsafe for a use case |

A `Verdict` carries a `provider` field precisely so a runtime can attribute,
meter, and benchmark each vendor's contribution.
