# openguardrails-instrumentation-langgraph

Guard a **custom [LangGraph](https://github.com/langchain-ai/langgraph) agent**
with the [OpenGuardrails (OGR)](https://openguardrails.com) protocol — a drop-in
`ToolNode` that enforces **one policy you own** at the **agent-hook altitude**,
using LangGraph's own `interrupt()` as the human-confirm gate.

```bash
pip install "openguardrails-instrumentation-langgraph[langgraph]"
```

## Why this is different from the other instrumentations

The opencode / OpenClaw / Claude Code bindings hook a **finished product's**
plugin surface. A developer hand-rolling an agent with LangGraph has no plugin
marketplace — they need a **library they `import`**. That library's natural
Policy Enforcement Point (PEP) is the tool boundary: in LangGraph, the
`ToolNode`. That node is the agent-hook altitude.

## What it enforces

Every `tool_call` the model emits is turned into an OGR `GuardEvent` and judged
by the reference `Runtime` (the PDP) before the tool runs:

| Tool call | Provenance | Decision |
| --- | --- | --- |
| `get_weather(city="Paris")` | trusted | `allow` — runs |
| `bash("rm -rf /")` | trusted | `block` — refused in place, never runs |
| `bash("curl … \| sh")` | trusted | `require_approval` → **interrupt()** |
| `bash("curl … \| sh")` | **untrusted** (after a web/retrieval result) | `block` — injection |

The last two rows are the point: the *same* command gets a different verdict
depending on where its inputs came from. A tool whose **result** carries
external content (web fetch, retrieval, MCP) taints the session, so a later tool
call inherits untrusted provenance — the indirect-prompt-injection defense.

## The human-confirm gate is LangGraph-native

A `require_approval` verdict doesn't invent an approval UI — it raises a
LangGraph [`interrupt()`](https://langchain-ai.github.io/langgraph/concepts/human_in_the_loop/).
The graph pauses at its checkpointer; a human approves; the graph resumes. This
keeps OGR's red line intact: **the confirm gate and the enforcement point stay
privilege-separated** — the agent cannot self-approve.

```python
from langgraph.types import Command

out = app.invoke({"messages": [...]}, config)      # pauses at __interrupt__
# ... surface out["__interrupt__"][0].value to a human ...
out = app.invoke(Command(resume=True), config)     # approve all
# or Command(resume={tool_call_id: True/False}) / a list of approved ids
```

Resume accepts `True`/`False`, `"approve"`/`"deny"`, a `{tool_call_id: bool}`
map, or a list of approved ids. Anything unrecognized **fails closed** (deny).

## Three integration surfaces

```python
from openguardrails_instrumentation_langgraph import (
    OpenGuardrailsToolNode, guard, ogr_guard,
)
```

**1. Drop-in `ToolNode`** — the primary PEP, for a hand-built `StateGraph`:

```python
graph.add_node("tools", OpenGuardrailsToolNode(tools))   # was ToolNode(tools)
app = graph.compile(checkpointer=MemorySaver())          # checkpointer needed for approvals
```

**2. `guard(tools)`** — when you don't own the ToolNode (e.g. the prebuilt agent):

```python
from langgraph.prebuilt import create_react_agent
agent = create_react_agent(model, guard(tools))
```

**3. `@ogr_guard`** — a single tool:

```python
@ogr_guard
@tool
def bash(command: str) -> str: ...
```

`OpenGuardrailsToolNode` gives full provenance/injection coverage (it sees the
run config and threads session taint); `guard()` / `ogr_guard` judge with base
provenance.

## The policy

[`policy.json`](src/openguardrails_instrumentation_langgraph/policy.json) is a
thin overlay — `{"$extends": "openguardrails:base"}`. The core resolves the
canonical PAP base and deep-merges your overlay into one effective policy, so the
same policy that fronts your gateway and sandbox also judges these tool calls.
Point elsewhere with `OGR_POLICY=/path/to/policy.json` or
`OpenGuardrailsToolNode(tools, policy="…")`.

## Altitude

This binding is the **agent-hook** altitude (the tool boundary). The **gateway**
altitude (prompt-injection / secret leakage on the LLM wire) is covered by
[`openguardrails-instrumentation-litellm`](https://github.com/openguardrails/openguardrails-instrumentation-litellm)
if your LangGraph app routes its model through litellm — the two compose.

## Try it

```bash
python examples/react_agent.py     # drives allow / block / approve / deny end-to-end
python tests/test_smoke.py         # offline decision-core test (no langgraph needed)
```
