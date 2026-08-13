"""The developer path (OGR v0.6): classify raw provider bodies.

A caller forwards the UNTOUCHED provider body — ``llm_request`` before it
reaches the model, ``llm_response`` before the agent acts on the answer —
and the PDP classifies it. This is the SDK-side twin of the hosted runtime's
derivation, so the in-process ``Runtime`` speaks the same contract as the
platform.

The derivation rewrites the event IN PLACE into the judged shape the
detectors read:

    llm_request  -> ``user_input`` (a user turn heads the new input) or
                    ``tool_result`` (a continuation feeding outcomes back),
                    payload {text?, tool_results?, tools?, system?}
    llm_response -> ``model_output``, payload {text, reasoning?, tool_calls?}

Only the NEW input is classified — everything after the last assistant turn;
re-scanning history would double-count findings on every turn. A body that
matches no known protocol keeps its raw kind with ``payload["unparsed"] =
True``: arrived-but-not-judged is a signal, never a silent drop. Protocols:
``openai.chat`` and ``anthropic.messages``; ``llm_protocol`` is a hint, the
shape is sniffed when absent.
"""
from __future__ import annotations

import json
from typing import Any

from .models import GuardEvent

_MAX_TOOLS = 64


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    parts: list[str] = []
    if isinstance(content, list):
        for part in content:
            if not isinstance(part, dict):
                continue
            if isinstance(part.get("text"), str):
                parts.append(part["text"])
            elif isinstance(part.get("content"), str):
                parts.append(part["content"])
    return "\n".join(p for p in parts if p)


def _sniff(ev: GuardEvent) -> str | None:
    if ev.llm_protocol in ("openai.chat", "anthropic.messages"):
        return ev.llm_protocol
    p = ev.payload
    messages = p.get("messages") if isinstance(p.get("messages"), list) else []
    if ev.kind == "llm_response":
        if isinstance(p.get("choices"), list) and p["choices"]:
            return "openai.chat"
        if p.get("type") == "message" or (isinstance(p.get("content"), list) and p["content"]):
            return "anthropic.messages"
        return None
    if not messages:
        return None
    if isinstance(p.get("system"), (str, list)):
        return "anthropic.messages"
    tools = [t for t in (p.get("tools") or []) if isinstance(t, dict)]
    if any("input_schema" in t for t in tools):
        return "anthropic.messages"
    if any("function" in t or t.get("type") == "function" for t in tools):
        return "openai.chat"
    for m in messages:
        for b in m.get("content") if isinstance(m.get("content"), list) else []:
            if isinstance(b, dict) and b.get("type") in ("tool_result", "tool_use"):
                return "anthropic.messages"
    return "openai.chat"


def _normalize_tools(proto: str, tools: Any) -> list[dict] | None:
    items = [t for t in (tools or []) if isinstance(t, dict)][:_MAX_TOOLS]
    if not items:
        return None
    out = []
    for t in items:
        fn = t.get("function") if isinstance(t.get("function"), dict) else None
        if proto == "openai.chat" and fn:
            out.append({"name": fn.get("name"), "description": fn.get("description", ""),
                        "schema": fn.get("parameters", {})})
        else:
            out.append({"name": t.get("name"), "description": t.get("description", ""),
                        "schema": t.get("input_schema", t.get("parameters", {}))})
    return out


def _derive_request(ev: GuardEvent, proto: str) -> None:
    p = ev.payload
    messages = [m for m in (p.get("messages") or []) if isinstance(m, dict)]

    if proto == "anthropic.messages":
        system = p.get("system") if isinstance(p.get("system"), str) else _text_of(p.get("system"))
    else:
        system = "\n".join(_text_of(m.get("content"))
                           for m in messages if m.get("role") in ("system", "developer"))

    last_assistant = -1
    for i, m in enumerate(messages):
        if m.get("role") == "assistant":
            last_assistant = i
    fresh = messages[last_assistant + 1:]

    user_texts: list[str] = []
    results: list[dict] = []
    for m in fresh:
        if m.get("role") == "tool":
            results.append({"tool_call_id": m.get("tool_call_id", ""),
                            "result": _text_of(m.get("content"))})
            continue
        if m.get("role") != "user":
            continue
        blocks = [b for b in (m.get("content") if isinstance(m.get("content"), list) else [])
                  if isinstance(b, dict)]
        for b in blocks:
            if b.get("type") == "tool_result":
                results.append({"tool_call_id": b.get("tool_use_id", ""),
                                "result": _text_of(b.get("content"))})
        text = m["content"] if isinstance(m.get("content"), str) else "\n".join(
            str(b.get("text", "")) for b in blocks if b.get("type") == "text")
        if text:
            user_texts.append(text)

    payload: dict[str, Any] = {}
    user_text = "\n".join(user_texts)
    if user_text:
        payload["text"] = user_text
    if results:
        payload["tool_results"] = results
    tools = _normalize_tools(proto, p.get("tools"))
    if tools:
        payload["tools"] = tools
    if system:
        payload["system"] = system

    ev.kind = "user_input" if user_text or not results else "tool_result"
    ev.payload = payload
    ev.llm_protocol = proto


def _derive_response(ev: GuardEvent, proto: str) -> None:
    p = ev.payload
    payload: dict[str, Any] = {}
    calls: list[dict] = []

    if proto == "openai.chat":
        choices = p.get("choices") or []
        msg = choices[0].get("message", {}) if choices and isinstance(choices[0], dict) else {}
        payload["text"] = _text_of(msg.get("content"))
        if isinstance(msg.get("reasoning"), str) and msg["reasoning"]:
            payload["reasoning"] = msg["reasoning"]
        for tc in msg.get("tool_calls") or []:
            if not isinstance(tc, dict):
                continue
            fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
            args: Any = fn.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except (ValueError, TypeError):
                    args = {"input": args}
            calls.append({"id": tc.get("id", ""), "name": fn.get("name", ""),
                          "arguments": args or {}})
    else:
        blocks = [b for b in (p.get("content") or []) if isinstance(b, dict)]
        payload["text"] = "\n".join(str(b.get("text", "")) for b in blocks
                                    if b.get("type") == "text")
        thinking = "\n".join(str(b.get("thinking", "")) for b in blocks
                             if b.get("type") == "thinking")
        if thinking:
            payload["reasoning"] = thinking
        for b in blocks:
            if b.get("type") == "tool_use":
                calls.append({"id": b.get("id", ""), "name": b.get("name", ""),
                              "arguments": b.get("input", {})})

    if calls:
        payload["tool_calls"] = calls
    ev.kind = "model_output"
    ev.payload = payload
    ev.llm_protocol = proto


def derive_llm_event(ev: GuardEvent) -> None:
    """Classify an ``llm_request``/``llm_response`` event in place; a no-op
    for every other kind. Never raises: an unrecognizable body keeps its raw
    kind with ``payload["unparsed"] = True``."""
    if ev.kind not in ("llm_request", "llm_response"):
        return
    try:
        proto = _sniff(ev)
        if proto is None:
            ev.payload["unparsed"] = True
            return
        if ev.kind == "llm_request":
            _derive_request(ev, proto)
        else:
            _derive_response(ev, proto)
    except Exception:  # noqa: BLE001 — honesty over crashing the decision path
        ev.payload["unparsed"] = True
