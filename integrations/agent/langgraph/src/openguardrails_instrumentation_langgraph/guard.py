"""Guard a LangGraph agent's model calls with OGR v0.8.

The chat-model invocation is where a LangGraph agent holds BOTH refusable
moments of a step: the messages it is about to send, and the returned tool
calls it has not yet executed. So the enforcement point is a MODEL WRAPPER,
not a ToolNode — wrap the model once and every step of every graph built on
it is judged before the provider sees it (``step/request``) and before the
agent acts on it (``step/response``). That is the two-POST recipe of
``specification/runtime-api.md``, verbatim; tool RESULTS need no call of
their own — they ride in the next step/request as the tool-role messages
they already are.

Enforcement is an exception, ``GuardrailBlocked``, because in a graph the
only universal "stop" is to unwind the node: a blocked request means the
model was never called, a blocked response means its tool calls never reach
the ToolNode. Deployments that prefer to route a block as graph state catch
it in their model node.
"""

from __future__ import annotations

import asyncio
import copy
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any

from .canonical import request_payload, response_payload
from .client import OgrClient

logger = logging.getLogger("openguardrails.langgraph")

_FAIL_MODES = ("open", "closed")


class GuardrailBlocked(RuntimeError):
    """Raised where the recipe says stop.

    ``kind`` says which half refused: ``step/request`` → the model was never
    called; ``step/response`` → its tool calls will never run. ``verdict``
    is the runtime's Verdict — or ``None`` when there was no verdict at all
    and ``fail_mode: closed`` turned "could not look" into a stop, which is
    not "found nothing" (degraded-mode.md).
    """

    def __init__(self, kind: str, verdict: dict | None, reason: str) -> None:
        super().__init__(f"[openguardrails] {kind} blocked: {reason}")
        self.kind = kind
        self.verdict = verdict
        self.reason = reason


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _pick(value: str | None, env: str, default: str = "") -> str:
    """Constructor beats environment beats default — and ``""`` stays a
    legal, explicit value (the four-tuple's "no assertion")."""
    if value is not None:
        return value
    return os.environ.get(env, default)


def _block_reason(verdict: dict) -> str:
    categories = sorted(
        {f.get("category", "?") for f in verdict.get("findings") or [] if f.get("action") == "block"}
    )
    return ", ".join(categories) if categories else "blocked by policy"


def _spans_by_path(verdict: dict | None) -> dict[str, list[dict]]:
    spans = ((verdict or {}).get("modifications") or {}).get("spans") or []
    by_path: dict[str, list[dict]] = {}
    for span in spans:
        by_path.setdefault(span.get("path", ""), []).append(span)
    return by_path


def _splice(text: str, spans: list[dict]) -> str:
    # Right-to-left so earlier offsets keep indexing the text as transported.
    for span in sorted(spans, key=lambda s: s["start"], reverse=True):
        text = text[: span["start"]] + span["replacement"] + text[span["end"] :]
    return text


def _with_content(message: Any, content: str) -> Any:
    """A shallow copy with redacted content — the caller's objects are never
    mutated. Works for langchain messages (attribute) and dicts alike."""
    if isinstance(message, dict):
        return {**message, "content": content}
    clone = copy.copy(message)
    clone.content = content
    return clone


class GuardedChatModel:
    """A chat model with the OGR recipe wrapped around every invocation.

    Deliberately NOT a blanket proxy: only ``invoke`` / ``ainvoke`` /
    ``bind_tools`` exist, so a call path that would bypass the guard (e.g.
    model-level ``.stream``) fails loudly instead of silently unjudged.
    Token streaming would need the spec's held-tail dance and is not wrapped
    here — graph-level streaming of node results is unaffected.
    """

    def __init__(
        self,
        model: Any,
        client: OgrClient,
        identity: dict[str, str],
        fail_mode: str,
        tools: list | None = None,
    ) -> None:
        if fail_mode not in _FAIL_MODES:
            raise ValueError(f"fail_mode must be one of {_FAIL_MODES}, got {fail_mode!r}")
        self.model = model
        self.client = client
        self.identity = identity
        self.fail_mode = fail_mode
        self.tools = list(tools) if tools else None

    # ── the recipe ────────────────────────────────────────────────────────

    def invoke(self, input: Any, config: Any = None, **kwargs: Any) -> Any:
        messages = _coerce_messages(input)
        step_id = uuid.uuid4().hex  # one id, both halves of this model call

        # ① before the model: judge exactly what is about to be sent
        payload = request_payload(messages, self.tools)
        verdict = self.client.evaluate(self._event("step/request", step_id, payload))
        self._enforce("step/request", verdict)
        messages = self._redact_request(verdict, messages)

        started_at = _now()
        response = self.model.invoke(messages, config, **kwargs)
        completed_at = _now()

        # ② after the model, BEFORE acting: the tool calls held here are the
        # only copy of an action anyone can still refuse
        payload = response_payload(response, started_at, completed_at)
        verdict = self.client.evaluate(self._event("step/response", step_id, payload))
        self._enforce("step/response", verdict)
        return self._redact_response(verdict, response, payload)

    async def ainvoke(self, input: Any, config: Any = None, **kwargs: Any) -> Any:
        """Same recipe; evaluates hop to a thread so the stdlib-blocking wire
        never stalls the event loop LangGraph is running on."""
        messages = _coerce_messages(input)
        step_id = uuid.uuid4().hex

        payload = request_payload(messages, self.tools)
        verdict = await asyncio.to_thread(
            self.client.evaluate, self._event("step/request", step_id, payload)
        )
        self._enforce("step/request", verdict)
        messages = self._redact_request(verdict, messages)

        started_at = _now()
        if hasattr(self.model, "ainvoke"):
            response = await self.model.ainvoke(messages, config, **kwargs)
        else:
            response = await asyncio.to_thread(self.model.invoke, messages, config, **kwargs)
        completed_at = _now()

        payload = response_payload(response, started_at, completed_at)
        verdict = await asyncio.to_thread(
            self.client.evaluate, self._event("step/response", step_id, payload)
        )
        self._enforce("step/response", verdict)
        return self._redact_response(verdict, response, payload)

    def bind_tools(self, tools: list, **kwargs: Any) -> "GuardedChatModel":
        """Re-wrap the bound model so the guard survives LangGraph's own
        ``create_react_agent`` plumbing — and remember the inventory, because
        tool DEFINITIONS travel on every step/request to be judged too."""
        bound = self.model.bind_tools(tools, **kwargs)
        return GuardedChatModel(bound, self.client, self.identity, self.fail_mode, tools)

    # ── event building and enforcement ────────────────────────────────────

    def _event(self, kind: str, step_id: str, payload: dict) -> dict:
        # The whole v0.8 GuardEvent: every field required, nothing else.
        return {
            "kind": kind,
            "step_id": step_id,
            **self.identity,
            "llm_protocol": "canonical",
            "payload": payload,
        }

    def _enforce(self, kind: str, verdict: dict | None) -> None:
        if verdict is None:
            # No answer (timeout, 429, 5xx, network). The decision is local
            # and pre-configured — no retry loop, no runtime round-trip.
            if self.fail_mode == "closed":
                raise GuardrailBlocked(
                    kind, None, "no verdict (runtime unreachable) and fail_mode is 'closed'"
                )
            logger.warning("%s went unjudged (runtime unreachable, failing open)", kind)
            return
        if verdict.get("decision") == "block":
            raise GuardrailBlocked(kind, verdict, _block_reason(verdict))
        if self.fail_mode == "closed" and verdict.get("unjudged"):
            # Same situation as an outage at a smaller size: "could not
            # look" at the very content being enforced.
            raise GuardrailBlocked(
                kind, verdict, f"verdict left paths unjudged: {verdict['unjudged']}"
            )

    # ── modification spans ────────────────────────────────────────────────
    # An allow may still carry spans the enforcement point MUST apply before
    # the content proceeds. Offsets index the payload AS TRANSPORTED — the
    # canonical strings this integration just built — so they resolve here,
    # against string message content (`payload.messages.N.content`) and the
    # response prose (`payload.text`). Anything else is unresolvable and
    # COUNTED: "no spans resolved" must stay distinguishable from "no
    # redaction policy" (verdict.md).

    def _redact_request(self, verdict: dict | None, messages: list) -> list:
        by_path = _spans_by_path(verdict)
        if not by_path:
            return messages
        messages = list(messages)
        for path, spans in by_path.items():
            index = _message_index(path, len(messages))
            content = None if index is None else _get_content(messages[index])
            if not isinstance(content, str):
                self.client.unresolved_spans += len(spans)
                continue
            messages[index] = _with_content(messages[index], _splice(content, spans))
        return messages

    def _redact_response(self, verdict: dict | None, response: Any, payload: dict) -> Any:
        by_path = _spans_by_path(verdict)
        if not by_path:
            return response
        for path, spans in by_path.items():
            if path == "payload.text" and isinstance(payload.get("text"), str):
                response = _with_content(response, _splice(payload["text"], spans))
            else:
                self.client.unresolved_spans += len(spans)
        return response


def _message_index(path: str, count: int) -> int | None:
    """``payload.messages.N.content`` → N, else None (unresolvable here)."""
    parts = path.split(".")
    if (
        len(parts) == 4
        and parts[0] == "payload"
        and parts[1] == "messages"
        and parts[2].isdigit()
        and parts[3] == "content"
        and int(parts[2]) < count
    ):
        return int(parts[2])
    return None


def _get_content(message: Any) -> Any:
    return message.get("content") if isinstance(message, dict) else getattr(message, "content", None)


def _coerce_messages(input: Any) -> list:
    """LangGraph hands a model node a message list; be tolerant of the two
    adjacent shapes (a graph state dict, a single message) without ever
    decomposing anything."""
    if isinstance(input, dict) and "messages" in input:
        return list(input["messages"])
    if isinstance(input, list):
        return input
    return [input]


def guard(
    model: Any,
    *,
    client: OgrClient | None = None,
    runtime_url: str | None = None,
    api_key: str | None = None,
    timeout: float | None = None,
    fail_mode: str | None = None,
    agent_id: str | None = None,
    agent_type: str | None = None,
    agent_workspace: str | None = None,
    agent_user: str | None = None,
    tools: list | None = None,
) -> GuardedChatModel:
    """Wrap a chat model in the OGR v0.8 recipe.

    Everything is constructor-or-environment. The four-tuple is REQUIRED on
    the wire with ``""`` as the explicit "no assertion" — so every field
    defaults to ``""`` (env: ``OGR_AGENT_ID`` etc.) except ``agent_type``,
    which defaults to ``"langgraph"``: the harness kind is the one thing
    this integration genuinely knows. ``fail_mode`` (``OGR_FAIL_MODE``)
    defaults to OPEN per the degraded-mode spec; a deployment gating
    dangerous actions passes ``"closed"`` and accepts that an outage pauses
    the agent.
    """
    resolved_fail_mode = fail_mode if fail_mode is not None else os.environ.get("OGR_FAIL_MODE", "open")
    identity = {
        "agent_id": _pick(agent_id, "OGR_AGENT_ID"),
        "agent_type": _pick(agent_type, "OGR_AGENT_TYPE", "langgraph"),
        "agent_workspace": _pick(agent_workspace, "OGR_AGENT_WORKSPACE"),
        "agent_user": _pick(agent_user, "OGR_AGENT_USER"),
    }
    resolved_client = client or OgrClient(runtime_url, api_key, timeout)
    return GuardedChatModel(model, resolved_client, identity, resolved_fail_mode, tools)
