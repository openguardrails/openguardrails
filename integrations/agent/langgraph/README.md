# openguardrails-instrumentation-langgraph

Guard a [LangGraph](https://github.com/langchain-ai/langgraph) agent with
**OpenGuardrails (OGR) v0.8** — a chat-model wrapper that runs the
[normative recipe](../../../specification/runtime-api.md#the-recipe) around
every model call: `step/request` judged **before the provider sees the
messages**, `step/response` judged **before the agent acts on the tool
calls**, both halves bound by one minted `step_id`.

There is no SDK and no dependency: the wire is two hand-rolled POSTs to
`/v1/evaluate` over stdlib `urllib`, and the langchain-core message surface
is duck-typed — this package never imports `langgraph` or `langchain`.

## Why the model wrapper is the enforcement point

A LangGraph agent holds its own model call: the model node invokes a chat
model with the full message list and receives the response whose
`tool_calls` have **not run yet**. Those are exactly the two refusable
moments the recipe names, so wrapping the model guards every step of every
graph built on it — including the prebuilt ReAct agent — with no per-node
work. (The v0.6 version of this package enforced at the ToolNode instead;
that machinery, and the SDK it rode on, are gone.)

## Usage

```python
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent
from openguardrails_instrumentation_langgraph import GuardrailBlocked, guard

model = guard(
    ChatOpenAI(model="gpt-5"),
    runtime_url="https://ogr.example.com",   # or OGR_RUNTIME_URL
    api_key="ogr_xxxxxxxx",                  # or OGR_API_KEY
    # the identity four-tuple — always on the wire, "" = no assertion
    agent_id="invoice-bot",                  # WHICH agent (policy + inventory key)
    agent_workspace="finance-agents",        # agent GROUP — one workspace, one policy set
    agent_user="u-8232",                     # who is USING it this session
    # agent_type defaults to "langgraph" — the one thing this harness knows
)

agent = create_react_agent(model, tools)     # bind_tools re-wraps; the guard survives

try:
    result = agent.invoke({"messages": [("user", "Pay invoice #42")]})
except GuardrailBlocked as blocked:
    # blocked.kind    → "step/request" (model never called)
    #                 | "step/response" (tool calls never executed)
    # blocked.verdict → the runtime's Verdict, or None under fail_mode="closed"
    #                   when the runtime was unreachable
    handle_refusal(blocked)
```

`invoke` and `ainvoke` are guarded; `bind_tools` re-wraps the bound model
and adds the tool inventory to every `step/request` (tool *definitions* are
an attack surface too). Anything else — notably model-level `.stream` —
deliberately does not exist on the wrapper, so an unjudged call path fails
loudly instead of silently bypassing the guard. Token-level streaming needs
the spec's [held-tail dance](../../../specification/runtime-api.md#streaming-hold-the-tail-judge-once)
and is not implemented here; graph-level streaming of node results is
unaffected.

## What goes on the wire

`llm_protocol: "canonical"` — a LangGraph agent holds LangChain message
objects, not a raw provider body, so the wrapper converts faithfully and
decomposes nothing: the system prompt stays `messages[0]`, tool results stay
the tool-role messages they are (paired by `tool_call_id`), an assistant
turn keeps its prose and all its tool calls together. The response carries
transcribed `usage` (only what the provider reported — never fabricated
zeros) and `timing {started_at, completed_at}`.

## Configuration

Constructor arguments win over environment variables; every identity field
defaults to `""` (the explicit "no assertion") except `agent_type`.

| `guard(...)` kwarg | Env | Default |
|---|---|---|
| `runtime_url` | `OGR_RUNTIME_URL` | — (required) |
| `api_key` | `OGR_API_KEY` | `""` |
| `timeout` | `OGR_TIMEOUT_S` | `5.0` |
| `fail_mode` | `OGR_FAIL_MODE` | `"open"` |
| `agent_id` | `OGR_AGENT_ID` | `""` |
| `agent_type` | `OGR_AGENT_TYPE` | `"langgraph"` |
| `agent_workspace` | `OGR_AGENT_WORKSPACE` | `""` |
| `agent_user` | `OGR_AGENT_USER` | `""` |

**Fail mode** ([degraded-mode](../../../specification/degraded-mode.md)):
when an evaluate gets no answer (timeout, 429, 5xx, network), the default is
**open** — the step proceeds, the gap is logged and counted. A deployment
gating dangerous actions passes `fail_mode="closed"`: no verdict (or a
verdict with unjudged paths) raises `GuardrailBlocked`, and an outage pauses
the agent. The client's counters (`events_sent`, `evaluate_errors`,
`unresolved_spans`) ride the optional heartbeat:

```python
model.client.heartbeat(agent_id="invoice-bot", interval_s=30)
```

An `allow` verdict may still carry `modifications.spans`; the wrapper
applies them in place — to request message contents before the model sees
them and to the response text before the agent does — and counts spans it
cannot resolve.

## Tests

Fully offline — a strict stdlib mock runtime validates every event against
the exact nine-field v0.8 GuardEvent, and the langchain surface is faked
(the package duck-types it, so the fakes *are* the interface under test):

```bash
python -m pytest integrations/agent/langgraph   # from the repo root
```
