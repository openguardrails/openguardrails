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

- We define the **wire** — the layer model, events, verdicts, composition,
  taxonomy.
- We **referee** the benchmark.
- We do **not** build detection capability — vendors compete behind the contract.

## The layer model: OGR beside OSI

**This is the protocol's foundational concept.** OGR is to agent traffic what
the layered network model is to packets — and it is built the way a firewall
is: an integration sees **one event at a time**, the way a firewall sees one
IP packet, and the runtime reassembles everything above it and reads
everything below it out of the payload.

| # | OGR layer | Network analogue | One unit is |
|---|---|---|---|
| **L6** | **Session** | — *(this domain's own layer)* | one conversation |
| **L5** | **Turn** | — *(this domain's own layer)* | one instruction → quiescence |
| **L4** | **Step** | transport | one model call: request + response, paired by `step_id` |
| **L3** | **Event** | **network — the packet** | one `GuardEvent`, half a step — **the only layer on the wire** |
| **L2** | **Call** | link | one tool call the model asked for |
| **L1** | **Exec** | physical | one real execution on a machine — *named by the model, not carried by the contract* |

Like a packet, an event is a **header** — `kind` (`step/request` \|
`step/response`), `step_id`, and the identity four-tuple `agent_id ·
agent_type · agent_workspace · agent_user` (OGR's answer to the firewall's
5-tuple) — plus a **payload**: the raw provider body. Everything above L3 is
**derived server-side** (sessions by conversation-prefix chaining, turns by
instruction boundaries and idle timeout — a firewall does not ask packets
which connection they belong to); everything below is parsed from the payload
(calls) or inferred (exec: no sensor observes it, and the gap between what a
call claims and what an exec does is precisely what agent security is about).

Two honest notes on the analogy. OGR follows the *pragmatic* TCP/IP cut — a
layer earns its place with its own unit, mechanism, and question — not OSI's
seven: above transport, networking has only "application", but agent traffic
*is* a dialogue with stable structure, so Turn and Session are this domain's
own layers, defined here rather than mapped onto OSI's vestigial
session/presentation layers. And the **agent is an endpoint, not a layer** —
it persists with zero traffic, sessions belong to it the way TCP connections
belong to a host, and it is addressed by the four-tuple every event carries.
Beside the stack sits the entity axis every firewall has: tenant (the API
key), **workspace** = security zone (one zone, one policy set), **agent** =
host, discovered from traffic into an inventory.

Each event gets a **verdict at the moment the integration can still refuse
it** — the request before the model sees it, the response before the agent
acts on it:

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

### The same six layers, in five other vocabularies

Agent harnesses already have words for this traffic. They line up:

| # | OGR | Network (OSI / TCP-IP) | OTel GenAI | OpenAI Agents SDK | Claude Agent SDK | LangGraph |
|---|---|---|---|---|---|---|
| **L6** | **Session** — one conversation | *no OSI layer* — the firewall's session table, idle aging | `gen_ai.conversation.id` *(no span)* | `Session` / `SQLiteSession` id; a trace's `group_id` | the session — `session_id`, `resume`, `fork` | the **thread** — `thread_id` + checkpointer |
| **L5** | **Turn** — one instruction → quiescence | *no OSI layer* — a flow's FIN / RST / timeout | `invoke_agent` span | one `Runner.run()` — one trace | one `query()` prompt, up to its `ResultMessage` | one `invoke()` / `stream()` on the graph |
| **L4** | **Step** — one model call | **transport** (OSI L4) | the inference span, `chat {model}` | `generation_span` / `response_span` — *their* "turn" | one loop round trip — *their* "turn" (`max_turns`) | one model-node execution (`before_model` → `after_model`) |
| **L3** | **Event** — half a step, **the wire unit** | **network** (OSI L3) — the packet | that span's start / end | that span's start / end | `AssistantMessage` out; tool results ride the **next** `UserMessage` | the two moments around the chat model's `invoke()` |
| **L2** | **Call** — one tool call | **data link** (OSI L2) | `execute_tool` span | `function_span` | a `tool_use` block; `PreToolUse` is its gate | a `ToolNode` call; `wrap_tool_call` is its gate |
| **L1** | **Exec** — one real execution | **physical** (OSI L1) | — | — | what `Bash` / `Edit` actually did on the host | what the tool function actually did |
| — | **Agent** *(entity, off the stack)* | host / endpoint | `gen_ai.agent.id` / `.name` | the `Agent` object (`agent_span`); a handoff switches it | the agent, and each subagent | the compiled graph |
| — | **Workspace** · **Tenant** | security zone · administrative boundary | *(`deployment.environment.name`)* | — | — | — |

**The numbers line up through L4 on purpose.** Exec/call/event/step sit on
physical/link/network/transport, and the packet is L3 in both columns. Above
transport the columns part: networking has only "application", because network
applications share no structure — agent traffic *is* a dialogue with stable
structure, so **turn and session are this domain's own L5 and L6**, not OSI's
session and presentation layers (the two practice discarded).

⚠️ **"Turn" means this stack's STEP in two of the three SDKs.** In both the
OpenAI Agents SDK and the Claude Agent SDK a *turn* is one iteration of the
agent loop — one model call plus the tool runs it triggers — and that is what
`max_turns` counts. An OGR **turn** is the user-instruction episode that
*contains* those iterations: one `Runner.run()`, one `query()` prompt, one
graph `invoke()`. Same word, one layer apart. (The OpenAI Agents SDK
documentation uses both senses: `max_turns` counts loop iterations, while "a
single logical turn in a chat conversation" is one `Runner.run()` — an OGR
turn.)

The full mapping — including what to send as `session_hint`, why an SDK *hook*
(`PreToolUse`, `wrap_tool_call`) is an enforcement point where a tracing span
is not, and how a handoff moves the entity axis rather than the stack — is in
[Overview § The layer model in harness vocabularies](specification/overview.md#the-layer-model-in-harness-vocabularies-non-normative).

Normative text: [Overview § The layer model](specification/overview.md).

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

SESSION = uuid.uuid4().hex   # optional session_hint: one id per conversation —
                             # sessions become declared instead of inferred

def evaluate(kind, step_id, payload):
    """The whole protocol is this one call. Fail-open: no verdict → proceed."""
    try:
        r = requests.post(f"{OGR}/v1/evaluate",
                          headers={"Authorization": f"Bearer {KEY}"},
                          json={"kind": kind, "step_id": step_id,
                                "llm_protocol": "openai.chat",
                                "session_hint": SESSION,
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
Full contract: [Runtime API](specification/runtime-api.md) — including
[a complete exchange](specification/runtime-api.md#a-complete-exchange): both
halves of one model call written out whole, with the verdict each returns.

**The questions the wire raises first** — which `llm_protocol` to declare, what
to send when your protocol is not one we list, why a different model does not
mean a different integration — are answered in the
[protocols FAQ](https://openguardrails.com/api/docs/faq/).

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
| [Overview](specification/overview.md) | The layer model and the integration surface | — |
| [GuardEvent](specification/guard-event.md) | The typed unit observed at an integration point | span / log record |
| [Verdict](specification/verdict.md) | The runtime's decision about an event | — |
| [obligations](specification/obligations.md) | What the enforcement point must DO before an action proceeds — carried beside an `allow` | XACML obligations |
| [artifact scan](specification/artifact-scan.md) | The sibling contract a scanner implements — hash-first, range-negotiated, pluggable | ICAP |
| [local redaction](specification/local-redaction.md) | What an in-process integration does so a secret never leaves the host — mask on the way out, restore into a tool, rules served by the runtime | — |
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
surface. v0.8 merged the two integration recipes into one, and every
integration below speaks it (v1.0 releases the same wire unchanged):

| Category | Target | Status | [Local redaction](specification/local-redaction.md) (1.4) |
|---|---|---|---|
| **Gateway** | Higress (Go/WASM) | [`integrations/gateway/higress`](integrations/gateway/higress/) — **the reference gateway integration** | n/a (the runtime masks for it) |
| | OpenAI/Anthropic example · mitmproxy | current | n/a (the runtime masks for it) |
| **Agent** | DeepSeek Harness (`dsh`) | [`integrations/agent/dsh`](integrations/agent/dsh/) — **the reference agent-direct integration** | no |
| | litellm | [`integrations/agent/litellm`](integrations/agent/litellm/) — current | no |
| | Hermes · opencode · OpenClaw | current | 2.0 / 0.4 / 0.4 (in progress) |
| | Claude Code · Codex · LangGraph | current | no |

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

Current protocol version: **v1.0** — the first stable release (see
[CHANGELOG.md](CHANGELOG.md) for protocol versions). The wire is stable:
changes within 1.x are additive-optional (`additionalProperties: false`
rejects unknown keys, not absent ones, so both ends roll forward
independently); anything breaking is a new major version. See
[GOVERNANCE.md](GOVERNANCE.md) for how the spec evolves. Contributions welcome —
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0.
