<div align="center">

# OpenGuardrails

**The vendor-neutral protocol for AI agent safety & security — and the neutral benchmark that ranks the vendors.**

Integrate safety & security once, enforce it across every agent, sandbox, and LLM — instead of wiring every vendor to every tool by hand.

Apache-2.0 · [openguardrails.com](https://openguardrails.com)

</div>

---

This is the home of the **OpenGuardrails (OGR) specification** — the normative
contract every adapter, detector, and sandbox speaks. OGR is **not a guardrail
product**: it defines the wire and referees the leaderboard. Vendors compete on
detection quality behind a common plug; users get one way to configure and
compose safety & security across every agent they run.

- We define the **wire** — events, verdicts, provenance, correlation, composition.
- We **referee** the benchmark.
- We do **not** build detection capability — vendors compete behind the contract.

```
   agent adapters            LLM-protocol adapters
  (hermes, openclaw,        (openai.chat, openai.responses,
   claude-code, codex,       anthropic.messages)
   opencode, kilocode)
        │                          │
        ▼                          ▼
   ┌───────────────────────────────────────────┐
   │  OGR core contract                          │
   │  GuardEvent · Verdict · Provenance ·        │
   │  guard-context · composition · taxonomy     │
   └───────────────────────────────────────────┘
        ▲                          ▲
        │                          │
   detector plugins           sandbox adapters
  (config rules OR           (srt, openshell —
   model/classifier)          runtime PEP + policy compile)
```

## Why a standard

Without OGR, securing an agent is an `N × M × L × S` integration problem: every
agent, every detector vendor, every LLM protocol, every sandbox wired pairwise.
OGR collapses it to `N + M + L + S` — integrate once against the contract.

## The six normative components

| Component | What it defines | OTel analogue |
|---|---|---|
| [GuardEvent](specification/guard-event.md) | The typed unit observed at an interception point | span / log record |
| [Verdict](specification/verdict.md) | A detector's decision about an event | — |
| [Provenance](specification/provenance-and-context.md) | Trust/taint labels on every piece of context | — |
| [guard-context](specification/provenance-and-context.md#guard-context-propagation) | Correlation of one logical action across gateway / hook / sandbox | trace context (W3C `traceparent`) |
| [composition](specification/composition.md) | How multiple vendors' verdicts combine into one decision | — |
| [enrollment & receipts](specification/enrollment-and-receipts.md) | How PEPs authenticate to a runtime, and how approvals become verifiable payload-bound artifacts | — |

Risk categories live in the [taxonomy](specification/taxonomy.md) (`safety.*` and
`security.*`), versioned and swappable — the contract references category IDs but
stays neutral on what is "unsafe."

## Two domains, one contract

- **Safety** — harmful *content/behavior* (toxicity, self-harm, CSAM, brand,
  topic). Mostly classifier-judged at the content I/O boundary.
- **Security** — *system compromise* (prompt injection, data exfiltration,
  malicious commands, SSRF, secret leakage, sandbox escape, supply chain).
  Mostly policy + provenance, enforceable down to the sandbox kernel.

The contract is unified; the pipelines and enforcement points differ. Start with
the [overview](specification/overview.md).

## Conformance & benchmark

- A detector is **OGR-conformant** if it accepts a `GuardEvent` and returns a
  valid `Verdict` against the [JSON Schemas](schema/). See [CONFORMANCE.md](CONFORMANCE.md).
- [`openguardrails-bench`](https://github.com/openguardrails/openguardrails-bench)
  evaluates conformant detectors on shared corpora and publishes the leaderboard.

---

## The ecosystem

The spec is here. Everything that implements it lives in its own repo, discoverable by name.

### Start here

| Repo | What it is |
|---|---|
| **openguardrails** (this repo) | The normative spec, schemas, taxonomy, conformance & governance. |
| [openguardrails-examples](https://github.com/openguardrails/openguardrails-examples) | Runnable proof + the index of every integration. `pip install openguardrails && python3 demo.py`. |
| [openguardrails-bench](https://github.com/openguardrails/openguardrails-bench) | The neutral detector leaderboard. |
| [openguardrails-gateway](https://github.com/openguardrails/openguardrails-gateway) | Reference service for the **gateway** altitude — terminate OpenAI/Anthropic, enforce on the wire. |

### SDKs (core runtime)

One per language. Every agent integration depends on the core.

| SDK | Core package |
|---|---|
| [openguardrails-js](https://github.com/openguardrails/openguardrails-js) | `@openguardrails/core` (npm) |
| [openguardrails-python](https://github.com/openguardrails/openguardrails-python) | `openguardrails` (PyPI) |

### Integrations — three altitudes, one policy

| Altitude | Target | Repo |
|---|---|---|
| **Agent hook** | Claude Code | [openguardrails-instrumentation-claude-code](https://github.com/openguardrails/openguardrails-instrumentation-claude-code) |
| | Codex | [openguardrails-instrumentation-codex](https://github.com/openguardrails/openguardrails-instrumentation-codex) |
| | opencode | [openguardrails-instrumentation-opencode](https://github.com/openguardrails/openguardrails-instrumentation-opencode) |
| | OpenClaw | [openguardrails-instrumentation-openclaw](https://github.com/openguardrails/openguardrails-instrumentation-openclaw) |
| | Hermes | [openguardrails-instrumentation-hermes](https://github.com/openguardrails/openguardrails-instrumentation-hermes) |
| **Sandbox** | Anthropic srt (personal) · NVIDIA OpenShell (multi-tenant) | [openguardrails-instrumentation-hermes](https://github.com/openguardrails/openguardrails-instrumentation-hermes) › `sandbox/` |
| **Gateway** | OpenAI · Anthropic · MCP | [openguardrails-gateway](https://github.com/openguardrails/openguardrails-gateway) |

## Principles

1. **Neutral.** The protocol is open and foundation-governed; the benchmark is a
   referee, not a contestant.
2. **Standardize the boundary, not the brains.** Detection stays competitive.
3. **Provenance-first.** The dangerous thing is usually untrusted input causing a
   privileged action — so trust labels are a core field, not an add-on.
4. **Defense in depth.** Gateway, agent hook, and sandbox observe one action,
   correlated by `guard_id`.

## Status

`v0` — draft. See [CHANGELOG.md](CHANGELOG.md) for protocol versions and
[GOVERNANCE.md](GOVERNANCE.md) for how the spec evolves. Contributions welcome —
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0.
