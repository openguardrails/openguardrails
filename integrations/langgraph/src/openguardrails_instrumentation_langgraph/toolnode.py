"""LangGraph bindings — enforce an OGR ToolDecision at the tool boundary.

Three surfaces, least-friction to most-control, all backed by one ``GuardEngine``:

  * ``OpenGuardrailsToolNode(tools, policy=...)`` — a drop-in replacement for
    LangGraph's ``ToolNode`` in a hand-built ``StateGraph``. The primary PEP:
    judges every tool_call before it runs, blocks in place, and routes a
    ``require_approval`` verdict through LangGraph's **native ``interrupt()``**
    so the human-confirm gate is the framework's own checkpoint/resume machinery
    — not a UI we invented. (OGR red line: the confirm gate and the enforcement
    point stay privilege-separated.)

  * ``guard(tools, policy=...)`` — wrap a list of tools; hand the result to
    ``create_react_agent(model, guard(tools))`` when you don't own the ToolNode.

  * ``@ogr_guard`` / ``ogr_guard(tool)`` — guard a single tool.

Real tool execution (sync/async, injected args, Command returns, error handling)
is delegated to the official ``ToolNode`` — this module only *gates*.
"""
from __future__ import annotations

from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import BaseTool, StructuredTool
from langgraph.types import interrupt

try:  # ToolNode moved modules across langgraph versions
    from langgraph.prebuilt import ToolNode
except ImportError:  # pragma: no cover
    from langgraph.prebuilt.tool_node import ToolNode

from ._engine import GuardEngine, ToolDecision, build_engine


def _session_id(config) -> str | None:
    if not config:
        return None
    return (config.get("configurable") or {}).get("thread_id")


def _messages(state):
    return state["messages"] if isinstance(state, dict) else state


def _deny_message(tool_call: dict, reason: str) -> ToolMessage:
    """A tool that OGR stopped becomes an error ToolMessage the model can read
    and react to — the model sees a refusal, never the (unrun) side effect."""
    return ToolMessage(
        content=f"[OpenGuardrails] {reason}",
        name=tool_call.get("name"),
        tool_call_id=tool_call["id"],
        status="error",
    )


def _approval_request(pending: list[dict], decisions: dict[str, ToolDecision]) -> dict:
    return {
        "ogr": "require_approval",
        "reason": "OpenGuardrails requires human approval before these tool calls run",
        "tool_calls": [
            {
                "id": tc["id"],
                "name": tc["name"],
                "args": tc.get("args", {}),
                "reasons": decisions[tc["id"]].reasons,
                "categories": decisions[tc["id"]].categories,
            }
            for tc in pending
        ],
    }


def _normalize_approvals(resume, pending: list[dict]) -> dict[str, bool]:
    """Interpret whatever the human passed to ``Command(resume=...)``.

    Accepts: ``True``/``False`` (approve/deny all), ``"approve"``/``"deny"``,
    a set/list of approved tool_call ids, or a ``{tool_call_id: bool}`` map.
    Default (anything unrecognized) is DENY — fail closed.
    """
    ids = [tc["id"] for tc in pending]
    if resume is True or resume in ("approve", "approved", "yes", "y", "allow"):
        return {i: True for i in ids}
    if resume is False or resume in ("deny", "denied", "no", "n", "block", None):
        return {i: False for i in ids}
    if isinstance(resume, dict):
        return {i: bool(resume.get(i, False)) for i in ids}
    if isinstance(resume, (list, set, tuple)):
        approved = set(resume)
        return {i: (i in approved) for i in ids}
    return {i: False for i in ids}


class OpenGuardrailsToolNode:
    """Drop-in for ``langgraph.prebuilt.ToolNode`` that enforces one OGR policy.

    Usage::

        graph.add_node("tools", OpenGuardrailsToolNode(tools))

    A ``require_approval`` verdict raises a LangGraph interrupt; resume with
    ``Command(resume=True)`` (approve all), ``Command(resume={id: bool})``, or a
    list of approved tool_call ids. Requires a checkpointer on the graph, exactly
    as any other interrupt does.
    """

    def __init__(
        self,
        tools,
        *,
        policy=None,
        engine: GuardEngine | None = None,
        name: str = "tools",
        agent_id: str = "langgraph",
    ):
        self.name = name
        self.agent_id = agent_id
        self.engine = engine or build_engine(policy)
        self._inner = ToolNode(tools, name=name)

    def _last_ai(self, msgs):
        for m in reversed(msgs):
            if isinstance(m, AIMessage):
                return m
        return None

    def __call__(self, state, config=None):
        msgs = _messages(state)
        ai = self._last_ai(msgs)
        if ai is None or not getattr(ai, "tool_calls", None):
            return {"messages": []}

        session_id = _session_id(config)

        # 1) judge every pending tool call
        decisions: dict[str, ToolDecision] = {}
        pending_approval: list[dict] = []
        for tc in ai.tool_calls:
            d = self.engine.evaluate_tool_call(
                tc["name"], tc.get("args", {}), session_id=session_id, agent_id=self.agent_id
            )
            decisions[tc["id"]] = d
            if d.needs_approval():
                pending_approval.append(tc)

        # 2) human-confirm gate — ONE interrupt carrying all pending approvals.
        #    First hit raises GraphInterrupt (graph pauses BEFORE any tool runs);
        #    on resume this returns the human's decision and we fall through.
        approvals: dict[str, bool] = {}
        if pending_approval:
            resume = interrupt(_approval_request(pending_approval, decisions))
            approvals = _normalize_approvals(resume, pending_approval)

        # 3) partition into runnable calls vs. synthesized refusals
        run_calls: list[dict] = []
        gated: list[ToolMessage] = []
        for tc in ai.tool_calls:
            d = decisions[tc["id"]]
            if d.needs_approval():
                if approvals.get(tc["id"], False):
                    run_calls.append(tc)
                else:
                    gated.append(_deny_message(tc, f"human reviewer denied: {tc['name']}"))
            elif d.allowed():
                run_calls.append(tc)
            else:
                gated.append(_deny_message(tc, f"blocked — {d.brief()}"))

        # 4) delegate real execution of the survivors to the official ToolNode
        out: list = []
        if run_calls:
            gated_ai = ai.model_copy(update={"tool_calls": run_calls})
            sub_msgs = [gated_ai if m is ai else m for m in msgs]
            result = self._inner.invoke({"messages": sub_msgs}, config)
            out.extend(result["messages"] if isinstance(result, dict) else result)
        out.extend(gated)

        # 5) taint: a tool whose result carries external content marks the
        #    session, so later tool calls inherit untrusted provenance.
        for tc in run_calls:
            if self.engine.taints_context(tc["name"]):
                self.engine.taint_session(session_id, source="tool_result")

        # 6) restore original tool_call order for a stable transcript
        order = {tc["id"]: i for i, tc in enumerate(ai.tool_calls)}
        out.sort(key=lambda m: order.get(getattr(m, "tool_call_id", None), len(order)))
        return {"messages": out}


def _as_tool(tool) -> BaseTool:
    if isinstance(tool, BaseTool):
        return tool
    return StructuredTool.from_function(tool)


def ogr_guard(tool=None, *, policy=None, engine: GuardEngine | None = None, agent_id: str = "langgraph"):
    """Guard a single tool. Usable as ``ogr_guard(mytool)`` or as a decorator.

    The returned tool preserves the original name / description / args schema
    (so the model sees the same tool), but on invocation it first asks the
    engine: ``block`` → returns a refusal string; ``require_approval`` →
    ``interrupt()`` for human confirm; otherwise runs the original tool.

    Note: session taint is only threaded by ``OpenGuardrailsToolNode`` (which
    sees the run config). A tool guarded standalone is judged with base
    provenance — use the ToolNode for full provenance/injection coverage.
    """
    eng = engine or build_engine(policy)

    def _wrap(t) -> BaseTool:
        base = _as_tool(t)

        def _gate(**kwargs):
            d = eng.evaluate_tool_call(base.name, kwargs, agent_id=agent_id)
            if d.needs_approval():
                resume = interrupt(_approval_request(
                    [{"id": base.name, "name": base.name, "args": kwargs}],
                    {base.name: d},
                ))
                approved = _normalize_approvals(resume, [{"id": base.name}]).get(base.name, False)
                if not approved:
                    return f"[OpenGuardrails] human reviewer denied: {base.name}"
            elif d.blocked():
                return f"[OpenGuardrails] blocked — {d.brief()}"
            return base.invoke(kwargs)

        return StructuredTool.from_function(
            func=_gate,
            name=base.name,
            description=base.description,
            args_schema=base.args_schema,
            return_direct=getattr(base, "return_direct", False),
        )

    # bare decorator form: @ogr_guard
    if tool is not None:
        return _wrap(tool)
    return _wrap


def guard(tools, *, policy=None, engine: GuardEngine | None = None, agent_id: str = "langgraph"):
    """Guard a list of tools for ``create_react_agent(model, guard(tools))``.

    Shares one engine across all wrapped tools so they enforce the same policy
    and, when run inside a graph with a checkpointer, the same interrupt gate.
    """
    eng = engine or build_engine(policy)
    return [ogr_guard(t, engine=eng, agent_id=agent_id) for t in tools]


__all__ = ["OpenGuardrailsToolNode", "guard", "ogr_guard"]
