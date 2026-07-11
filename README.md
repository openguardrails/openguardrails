<div align="center">

# OpenGuardrails

**The vendor-neutral protocol for AI agent safety & security — and the neutral benchmark that ranks the vendors.**

Integrate safety & security once, enforce it across every agent, sandbox, and LLM — instead of wiring every vendor to every tool by hand.

Apache-2.0 · [openguardrails.com](https://openguardrails.com)

</div>

---

This monorepo is the home of the **OpenGuardrails (OGR) specification and its
reference implementations**. The specification is the normative contract every
adapter, detector, and sandbox speaks; the SDKs, integrations, gateway,
benchmark, examples, skill, and website live alongside it so changes can be
reviewed and tested together.

OGR is **not a guardrail product**: it defines the wire and referees the
leaderboard. Vendors compete on detection quality behind a common plug; users
get one way to configure and compose safety & security across every agent they
run.

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
- The [benchmark](benchmarks/) evaluates conformant detectors on shared corpora
  and publishes the leaderboard.

---

## Monorepo layout

| Path | What it contains |
|---|---|
| [`specification/`](specification/) and [`schema/`](schema/) | Normative protocol, schemas, taxonomy, conformance, and governance. |
| [`packages/python/`](packages/python/) | `openguardrails` Python runtime (PyPI). |
| [`packages/javascript/`](packages/javascript/) | `@openguardrails/core` JavaScript/TypeScript runtime (npm). |
| [`integrations/`](integrations/) | Claude Code, Codex, Hermes, LangGraph, OpenClaw, and opencode bindings. |
| [`services/gateway/`](services/gateway/) | Reference OpenAI/Anthropic gateway service. |
| [`benchmarks/`](benchmarks/) | Neutral detector benchmark and leaderboard. |
| [`examples/`](examples/) | Runnable examples and integration index. |
| [`skills/openguardrails/`](skills/openguardrails/) | Agent skill for drafting and enforcing policies. |
| [`website/`](website/) | Source for [openguardrails.com](https://openguardrails.com). |

Packages remain independently versioned and published. The monorepo only
centralizes source, issues, pull requests, CI, and cross-component changes.
See [MONOREPO.md](MONOREPO.md) for the former-repository mapping and rollout
checklist, and [RELEASING.md](RELEASING.md) for npm/PyPI release tags.

### Integrations — three altitudes, one policy

| Altitude | Target | Source |
|---|---|---|
| **Agent hook** | Claude Code | [`integrations/claude-code`](integrations/claude-code/) |
| | Codex | [`integrations/codex`](integrations/codex/) |
| | opencode | [`integrations/opencode`](integrations/opencode/) |
| | OpenClaw | [`integrations/openclaw`](integrations/openclaw/) |
| | Hermes | [`integrations/hermes`](integrations/hermes/) |
| | LangGraph | [`integrations/langgraph`](integrations/langgraph/) |
| **Sandbox** | Anthropic srt · NVIDIA OpenShell | [`integrations/hermes`](integrations/hermes/) |
| **Gateway** | OpenAI · Anthropic | [`services/gateway`](services/gateway/) |

## Development

The JavaScript packages use npm workspaces:

```bash
npm install
npm run build
npm test
```

The Python packages form a uv workspace and can also be installed with pip:

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install pytest
python -m pip install -e packages/python -e services/gateway \
  -e integrations/hermes -e integrations/langgraph
python -m pytest
```

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
