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

## The layer model in harness vocabularies (non-normative)

An agent harness already has words for this traffic before OGR arrives: the
**tracing** vocabulary (OpenTelemetry's GenAI semantic conventions, and
dialects of it such as OpenInference), and each SDK's own — the **OpenAI
Agents SDK**, the **Claude Agent SDK**, **LangGraph**. They describe the same
traffic this stack describes, so the correspondence is worth stating exactly.
This section is **informative**: no part of the wire contract depends on it,
and an integration is never required to emit, consume, or name any of it.

⚠️ Two unrelated meanings of one word: a **tracing span** is a timed operation
in a trace; a Verdict's [`modifications.spans`](verdict.md#modifications) are
character offset ranges in a text. Where this section says "span" it means the
first.

### The map

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

### Tracing spans

Three differences that are not vocabulary, and are why OGR does not simply
consume spans:

1. **A span is an interval; a GuardEvent is a half.** A span is written when
   its operation *ends* — after the model has answered, after the tool has
   run. OGR's two moments are the ones where something is still held and can
   still be refused: before the request reaches the model, and after the
   response arrives but before the agent acts on it. A span cannot block, so a
   step is two events rather than one record. (An SDK **hook** can refuse —
   see the three sections below; a span never can.)
2. **A span declares its coordinates; a GuardEvent declares one.** `trace_id`,
   `span_id` and `parent_span_id` are producer-authored — and a producer that
   can declare a flow can get the flow wrong. The wire keeps `step_id` only,
   because pairing the two halves of one model call under concurrency is the
   one fact a runtime cannot derive; sessions, turns and step numbers are
   derived server-side.
3. **Telemetry is best-effort and sampled; enforcement is neither.** Dropping
   spans is normal operation; a dropped guard event is an unjudged model call.
   The same asymmetry governs content: message capture is opt-in for a tracer
   (`gen_ai.input.messages` / `gen_ai.output.messages`) and unconditional here,
   because the content IS the event.

A fourth difference is shape. A trace is an open-ended tree — any framework may
nest whatever spans it likes — while this stack is six fixed layers, so the same
traffic from two different harnesses lands on the same coordinates.

If your harness already emits spans, three mappings are directly useful:

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

In OpenInference, span kind `AGENT` ≈ turn, `LLM` ≈ step, `TOOL` ≈ call,
`session.id` ≈ session, `user.id` ≈ `agent_user`; its `GUARDRAIL` kind is where
an OGR `evaluate` call itself would appear if you traced it.

### OpenAI Agents SDK

- **Session** — a `Session` (`SQLiteSession("user_123")`) is the conversation
  the runner prepends and appends to. Send its id as `session_hint`; a trace's
  `group_id` carries the same fact and is equally good.
- **Turn** — one `Runner.run()` / `run_sync()` / `run_streamed()`, which the SDK
  also wraps in one trace. Its `RunResult` is the turn's outcome.
- **Step** — one iteration of the runner's loop: the `generation_span` (chat
  completions) or `response_span` (Responses API) is 1:1 with the model call.
  Mint `step_id` from that span's id and wrap the model call — a custom
  `Model` / `ModelProvider` is the natural enforcement point, because it holds
  the request before it is sent and the response before the runner acts on the
  tool calls.
- **Call** — a `function_span`. A `guardrail_span` is where the `evaluate` call
  itself appears if you trace it; note that the SDK's own input/output
  guardrails run *beside* the model call, while OGR's decision is *in* it.
- **Handoff** — `handoff_span` has no layer, because a handoff is movement on
  the ENTITY axis, not a unit of traffic: the steps after it carry a different
  `agent_id` inside the same turn and the same session. `agent_span` is that
  agent's slice of the run, and an agent is an endpoint, not a layer.

### Claude Agent SDK

- **Session** — the SDK's own session: `session_id` off the init
  `SystemMessage` or `ResultMessage`, `resume` to return to it, `fork` to
  branch it. Send it as `session_hint` — this SDK produces both cases the hint
  exists for. **Compaction** (`compact_boundary`) rewrites the history, so the
  conversation prefix a runtime chains on disappears mid-conversation; **fork**
  does the opposite, giving two live sessions that share a long identical
  prefix. Content alone re-attaches the first wrongly and merges the second;
  the hint settles both.
- **Turn** — one `query()` prompt, up to its `ResultMessage`. (In
  `ClaudeSDKClient`, one `client.query()` call.)
- **Step** — one round trip of the loop, which this SDK calls a turn: the
  `AssistantMessage` is the response half (text, thinking, and `tool_use`
  blocks together — one generation, one event), and the `UserMessage` carrying
  tool results is part of the NEXT request half. That is the same rule this
  spec states: a call's result is judged in the following `step/request`.
- **Call** — a `tool_use` block, gated by the `PreToolUse` hook. That hook is
  an enforcement point in the OGR sense — it can reject a call and hand the
  model a rejection instead — and it is where the `claude-code` integration in
  this repository sits.
- **Exec** — what `Bash`, `Write` or `Edit` actually did on the host. Named by
  the model, not carried by the contract.
- **Subagents** — a subagent runs its own conversation with fresh context and
  returns only its final response to the parent as a tool result. Its traffic
  is its own session; give it its own `session_hint`, and assert the same
  `agent_id` unless you want it inventoried as a separate agent.

### LangGraph

- **Session** — the **thread**: `configurable.thread_id`, persisted by a
  checkpointer. That id is the `session_hint`; the checkpointer is the local
  analogue of the runtime's session table.
- **Turn** — one `invoke()` / `stream()` on the compiled graph for that thread.
- **Step** — one execution of the model node (`create_agent`'s `before_model`
  → `after_model` window; the chat model's `invoke()` in the prebuilt ReAct
  agent). **Not a super-step**: a super-step is graph-execution granularity —
  parallel nodes share one, and a node that calls no model produces no events
  at all. This stack observes the model plane, not the graph.
- **Call** — a `ToolNode` execution, gated by `wrap_tool_call`.
- **State** — `AgentState.messages` (the `add_messages` reducer) is the
  conversation the request payload carries; there is no need to send state
  separately.
- **Interrupt** — `interrupt()` / `HumanInTheLoopMiddleware` is the structural
  twin of a `block`: the graph pauses before a consequential call. The
  difference is who answers — a person there, a policy decision point here.
- The integration this repository ships wraps the **chat model** for exactly
  this reason: the model node holds both refusable moments, so every graph
  built on that model is covered without per-node work.

### What none of them have

Everything above the agent. An SDK models one process; **workspace** (one
security zone, one policy set) and **tenant** (the administrative boundary,
carried by the API key and never by the payload) exist because a fleet is
governed, not a run. `deployment.environment.name` is the nearest neighbor a
tracing vocabulary offers, and it is not a policy boundary.

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
