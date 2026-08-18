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

## Integrate your agent in five minutes

The whole protocol is **one endpoint, two calls per model call**. You forward
the exact bodies you already send to and receive from your LLM; the runtime
does everything else (sessions, turns, decomposition, detection). Fail-open by
default: if the runtime is unreachable, your agent keeps running.

```python
import uuid, requests

OGR = "https://ogr.example.com"           # your runtime's base URL
KEY = "ogr_xxxxxxxx"                      # your organization API key

# The identity four-tuple. All four always present; "" = nothing to assert
# (the runtime then derives identity from the API key).
IDENTITY = {
    "agent_id":        "invoice-bot",     # WHICH agent — unique in your org
    "agent_type":      "my-harness",      # what KIND — a label, never policy
    "agent_workspace": "finance-agents",  # agent GROUP — one policy set
    "agent_user":      "u-8232",          # who is USING it this session
}

def evaluate(kind, step_id, payload):
    """The whole protocol is this one call. Fail-open: no verdict → proceed."""
    try:
        r = requests.post(f"{OGR}/v1/evaluate",
                          headers={"Authorization": f"Bearer {KEY}"},
                          json={"kind": kind, "step_id": step_id,
                                "llm_protocol": "openai.chat",
                                **IDENTITY, "payload": payload},
                          timeout=5)
        return r.json() if r.ok else None
    except requests.RequestException:
        return None

def blocked(v):
    return v is not None and v["decision"] == "block"

# your agent loop, with the two calls added:
while True:
    step_id = uuid.uuid4().hex                     # binds this call's 2 events
    body = {"model": "gpt-5", "messages": messages, "tools": TOOLS}
    if blocked(evaluate("step/request", step_id, body)):     # ① before the model
        break
    resp = call_llm(body)                                    # your code, unchanged
    if blocked(evaluate("step/response", step_id, resp)):    # ② before acting on it
        break
    ...                                            # execute tool calls, loop
```

Runnable version (with streaming): [`examples/minimal-agent/`](examples/minimal-agent/).
Full contract: [Runtime API](specification/runtime-api.md).

## The model

An agent works in a loop, and OGR names that loop the way agent harnesses do:
a **session** (one conversation) holds **turns** (one instruction →
quiescence), a turn holds **steps** (one model call each), and a step's
response holds **calls** (the tool calls the model asked for). One step is
reported as two events — `step/request` before the model call,
`step/response` after it and before the agent acts — and each event gets a
verdict at the moment the integration can still refuse it. The two events of
one model call share a producer-minted `step_id`; everything above the step
(session, turn, numbering) is **derived server-side** — an integration keeps
no loop state for OGR.

```
  your own agent · harness plugins        gateway integrations
  (two POSTs at the loop's seams)         (an LLM proxy: Higress, …)
        │                                       │
        │   raw provider bodies + step_id       │
        ▼                                       ▼
   ┌───────────────────────────────────────────────┐
   │  OGR core contract                            │
   │  GuardEvent · Verdict ·                       │
   │  composition · taxonomy                       │
   └───────────────────────────────────────────────┘
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

**There is no SDK layer.** The API is the integration surface — one decision
endpoint and [one recipe](specification/runtime-api.md#the-recipe) — and
agent developers integrate by calling it directly:

| Layer | What it is | Where |
|---|---|---|
| **API** | The wire contract a runtime (PDP) exposes: `POST /v1/evaluate` (decide + record), heartbeat, health — carrying `GuardEvent`s and returning `Verdict`s. | [Runtime API binding](specification/runtime-api.md) + [JSON Schemas](schema/) |
| **Plugin** | A hook for one surface — an agent harness or a gateway — that observes steps, builds events, and enforces verdicts, speaking the API directly. | [`integrations/`](integrations/) |

## The normative components

| Component | What it defines | OTel analogue |
|---|---|---|
| [Overview](specification/overview.md) | The session/turn/step/call model and the integration surface | — |
| [GuardEvent](specification/guard-event.md) | The typed unit observed at an integration point | span / log record |
| [Verdict](specification/verdict.md) | The runtime's decision about an event | — |
| [composition](specification/composition.md) | How multiple detectors' answers combine into one decision | — |
| [degraded mode](specification/degraded-mode.md) | What an integration does when the runtime is unreachable (default: fail open) | — |
| [Runtime API](specification/runtime-api.md) | The HTTP binding a runtime exposes, the recipe, and the minimal integration | OTLP/HTTP |

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
| [`examples/`](examples/) | The runnable minimal integration (`minimal-agent/`). |
| [`skills/openguardrails/`](skills/openguardrails/) | Agent skill for drafting and enforcing policies. |
| — | [openguardrails.com](https://openguardrails.com) lives in a separate repository; this repo holds the protocol and plugins it documents. |

### Integration status

The v0.6 SDK packages were retired in v0.7 — the API is the integration
surface. v0.8 merged the two integration recipes into one; integrations
return plugin by plugin as each is rewritten against it:

| Category | Target | Status |
|---|---|---|
| **Gateway** | Higress (Go/WASM) | [`integrations/gateway/higress`](integrations/gateway/higress/) — **v0.8 reference gateway integration** |
| **Agent** | DeepSeek Harness (`dsh`) | [`integrations/agent/dsh`](integrations/agent/dsh/) — **v0.8 reference agent-direct integration** |
| | litellm | [`integrations/agent/litellm`](integrations/agent/litellm/) — v0.8 |
| | Claude Code · Codex · opencode · OpenClaw · Hermes · LangGraph | pending v0.8 rewrite |
| **Gateway** | OpenAI/Anthropic example · mitmproxy | pending v0.8 rewrite |

## Development

```bash
# benchmark tests
python -m pip install pytest && python -m pytest

# higress plugin
cd integrations/gateway/higress && go test ./...

# dsh plugin (npm workspace)
npm install && npm run build && npm test
```

## Principles

1. **Neutral.** The protocol is open and foundation-governed; the benchmark is a
   referee, not a contestant.
2. **Standardize the boundary, not the brains.** Detection stays competitive.
3. **Name the loop the way harnesses do.** Session, turn, step, call — an
   integration should never have to translate its own vocabulary to speak the
   wire.
4. **The wire carries what only the producer knows.** Identity and the
   step-pairing id are asserted; everything derivable — sessions, turns,
   numbering, timestamps, protocol versions — is the runtime's job, so the
   integration stays stateless.

## Status

Current protocol version: **v0.8** (see [CHANGELOG.md](CHANGELOG.md) for
protocol versions). Minor versions before v1 may still break between releases;
each break is logged. See
[GOVERNANCE.md](GOVERNANCE.md) for how the spec evolves. Contributions welcome —
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0.
