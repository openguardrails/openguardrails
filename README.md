<div align="center">

# OpenGuardrails

**The vendor-neutral protocol for AI agent safety & security — and the neutral benchmark that ranks the vendors.**

Integrate safety & security once, enforce it across every agent and LLM — instead of wiring every vendor to every tool by hand.

Apache-2.0 · [openguardrails.com](https://openguardrails.com)

</div>

---

This monorepo is the home of the **OpenGuardrails (OGR) specification and its
reference integrations**. The specification is the normative contract every
integration and detector speaks; the integrations, benchmark, examples, skill,
and website live alongside it so changes can be reviewed and tested together.

OGR is **not a guardrail product**: it defines the wire and referees the
leaderboard. Vendors compete on detection quality behind a common plug; users
get one way to configure and compose safety & security across every agent they
run.

- We define the **wire** — the session/turn/step/call model, events, verdicts,
  composition, taxonomy.
- We **referee** the benchmark.
- We do **not** build detection capability — vendors compete behind the contract.

## The model

An agent works in a loop, and OGR names that loop the way agent harnesses do:
a **session** (one conversation) holds **turns** (one instruction →
quiescence, closed with a reason), a turn holds **steps** (one model call
each), and a step's response holds **calls** (the tool calls the model asked
for). One step is reported as two events — `step/request` before the model
call, `step/response` after it and before the agent acts — and each event gets
a verdict at the moment the integration can still refuse it.

```
  agent-direct integrations          gateway integrations
  (a plugin in the harness, or       (an LLM proxy: Higress, …)
   the harness calling the API       sees one model call at a time;
   itself — declares session/        the runtime derives the
   turn/step, reports turn ends)     coordinates server-side
        │                                  │
        ▼                                  ▼
   ┌───────────────────────────────────────────┐
   │  OGR core contract                        │
   │  GuardEvent · Verdict ·                   │
   │  composition · taxonomy                   │
   └───────────────────────────────────────────┘
                       ▲
                       │
                detector plugins
               (config rules OR model/classifier)
```

## Why a standard

Without OGR, securing an agent is an `N × M × L` integration problem: every
agent, every detector vendor, every LLM protocol wired pairwise. OGR collapses
it to `N + M + L` — integrate once against the contract.

## Two layers: API → Plugin

**There is no SDK layer.** The API is the integration surface — two POST
endpoints and two normative recipes — and agent developers integrate by
calling it directly:

| Layer | What it is | Where |
|---|---|---|
| **API** | The wire contract a runtime (PDP) exposes: `POST /v1/evaluate`, `POST /v1/ingest`, heartbeat, health — carrying `GuardEvent`s and returning `Verdict`s — plus the two [integration recipes](specification/runtime-api.md#the-two-integration-recipes). | [Runtime API binding](specification/runtime-api.md) + [JSON Schemas](schema/) |
| **Plugin** | A hook for one surface — an agent harness or a gateway — that observes steps, builds events, and enforces verdicts, speaking the API directly. | [`integrations/`](integrations/) |

## The normative components

| Component | What it defines | OTel analogue |
|---|---|---|
| [Overview](specification/overview.md) | The session/turn/step/call model and the two integration points | — |
| [GuardEvent](specification/guard-event.md) | The typed unit observed at an integration point | span / log record |
| [Verdict](specification/verdict.md) | The runtime's decision about an event | — |
| [composition](specification/composition.md) | How multiple detectors' answers combine into one decision | — |
| [degraded mode](specification/degraded-mode.md) | What an integration does when the runtime is unreachable | — |
| [Runtime API](specification/runtime-api.md) | The HTTP binding a runtime exposes, and the two integration recipes | OTLP/HTTP |

Risk categories live in the [taxonomy](specification/taxonomy.md) (`safety.*` and
`security.*`), versioned and swappable — the contract references category IDs but
stays neutral on what is "unsafe."

## Two domains, one contract

- **Safety** — harmful *content/behavior* (toxicity, self-harm, CSAM, brand,
  topic). Mostly classifier-judged at the content I/O boundary.
- **Security** — *system compromise* (prompt injection, data exfiltration,
  malicious commands, SSRF, secret leakage, supply chain). Judged on actions
  and data flow — what a tool call is about to do.

The contract is unified; the pipelines and enforcement points differ. Start with
the [overview](specification/overview.md).

## Conformance & benchmark

- A detector is **OGR-conformant** if it accepts a `GuardEvent` and returns a
  valid `Verdict` against the [JSON Schemas](schema/). See [CONFORMANCE.md](CONFORMANCE.md).
- The [benchmark](benchmarks/) evaluates conformant detectors on shared corpora
  and publishes the leaderboard.

---

## Monorepo layout

| Path | What it contains |
|---|---|
| [`specification/`](specification/) and [`schema/`](schema/) | Normative protocol, schemas (JSON Schemas + OpenAPI), taxonomy, conformance, and governance. |
| [`integrations/`](integrations/) | Agent and gateway integrations, each speaking the API directly. |
| [`benchmarks/`](benchmarks/) | Neutral detector benchmark and leaderboard. |
| [`examples/`](examples/) | Runnable examples and integration index. |
| [`skills/openguardrails/`](skills/openguardrails/) | Agent skill for drafting and enforcing policies. |
| — | [openguardrails.com](https://openguardrails.com) lives in a separate repository; this repo holds the protocol and plugins it documents. |

### Integration status

The v0.6 SDK packages (`openguardrails` on PyPI, `@openguardrails/core` on
npm) and the plugins built on them were **retired in v0.7** — the API is the
integration surface now. Integrations return plugin by plugin as each is
rewritten against the v0.7 contract:

| Category | Target | Status |
|---|---|---|
| **Gateway** | Higress (Go/WASM) | [`integrations/gateway/higress`](integrations/gateway/higress/) — **v0.7 reference gateway integration** |
| **Agent** | DeepSeek Harness (`dsh`) | v0.7 rewrite planned first — the reference agent-direct integration |
| | Claude Code · Codex · opencode · OpenClaw · Hermes · LangGraph | v0.6-stale, pending v0.7 rewrite |
| **Gateway** | OpenAI/Anthropic example · mitmproxy | v0.6-stale, pending v0.7 rewrite |

## Development

```bash
# benchmark tests
python -m pip install pytest && python -m pytest

# higress plugin
cd integrations/gateway/higress && go test ./...
```

## Principles

1. **Neutral.** The protocol is open and foundation-governed; the benchmark is a
   referee, not a contestant.
2. **Standardize the boundary, not the brains.** Detection stays competitive.
3. **Name the loop the way harnesses do.** Session, turn, step, call — an
   integration should never have to translate its own vocabulary to speak the
   wire.
4. **Declared beats derived.** An integration that owns its loop stamps the
   coordinates; the runtime reconstructs only for vantage points that cannot
   know, and says which answer you got.

## Status

Current protocol version: **v0.7** (see [CHANGELOG.md](CHANGELOG.md) for
protocol versions). Minor versions before v1 may still break between releases;
each break is logged. See
[GOVERNANCE.md](GOVERNANCE.md) for how the spec evolves. Contributions welcome —
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0.
