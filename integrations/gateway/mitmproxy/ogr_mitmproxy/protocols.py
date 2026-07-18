"""Wire-protocol adapters: OpenAI Chat Completions / Responses, Anthropic Messages.

Extract the moderatable text from a request (the latest user turn) and a response
(the completion), and mint a protocol-correct block response so a blocked flow
looks like a normal API error to the caller. Mirrors the shapes used by the
in-process reference gateway (integrations/gateway/openai-anthropic).
"""
from __future__ import annotations

import json
from typing import Any

from mitmproxy import http

from .ogr_client import new_id

# request path -> OGR llm_protocol tag (schema: openai.chat|openai.responses|anthropic.messages)
_PATHS = {
    "/v1/chat/completions": "openai.chat",
    "/v1/responses": "openai.responses",
    "/v1/messages": "anthropic.messages",
}


def match(path: str) -> str | None:
    """Return the llm_protocol for an LLM API path, or None to pass the flow through."""
    p = path.split("?", 1)[0]
    for suffix, proto in _PATHS.items():
        if p.endswith(suffix):
            return proto
    return None


def new_guard_id() -> str:
    return new_id("gw")


def _content_text(content: Any) -> str:
    """OpenAI/Anthropic message content is a string or a list of typed parts."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, dict):
                parts.append(p.get("text") or p.get("content") or "")
            else:
                parts.append(str(p))
        return "\n".join(x for x in parts if x)
    return "" if content is None else str(content)


def _messages(proto: str, body: dict) -> list[dict]:
    if proto == "anthropic.messages":
        msgs = []
        if body.get("system"):
            msgs.append({"role": "system", "content": body["system"]})
        msgs.extend(body.get("messages", []))
        return msgs
    if proto == "openai.responses":
        # Responses API: `input` may be a string or a list of message-like items.
        inp = body.get("input")
        if isinstance(inp, str):
            return [{"role": "user", "content": inp}]
        if isinstance(inp, list):
            return inp
        return body.get("messages", [])
    return body.get("messages", [])  # openai.chat


def parse_request(proto: str, body: dict) -> dict:
    """-> {model, messages:[{role,content}], latest_user:str}."""
    messages = _messages(proto, body)
    latest_user = ""
    for m in reversed(messages):
        if m.get("role") == "user":
            latest_user = _content_text(m.get("content"))
            break
    return {"model": body.get("model"), "messages": messages, "latest_user": latest_user}


def parse_response(proto: str, body: dict) -> str:
    """Extract the assistant completion text from a (non-streaming) response body."""
    if proto == "anthropic.messages":
        return _content_text(body.get("content"))
    if proto == "openai.responses":
        if body.get("output_text"):
            return _content_text(body["output_text"])
        return _content_text(body.get("output"))
    # openai.chat
    choices = body.get("choices") or []
    if choices:
        return _content_text((choices[0].get("message") or {}).get("content"))
    return ""


# ── Codex (ChatGPT backend) WebSocket transport ───────────────────────────────
# Codex in ChatGPT-login mode does NOT use plain HTTP; it opens a WebSocket to
# chatgpt.com/backend-api/codex/responses and sends the request as a
# `response.create` text frame (Responses API shape). The user turn is an
# input[] item: {"type":"message","role":"user","content":[{"type":"input_text",
# "text":...}], "internal_chat_message_metadata_passthrough":{"turn_id":...}}.
CODEX_WS_PATH = "/backend-api/codex/responses"

# Codex runs its own built-in action reviewer as a second model on the SAME
# socket (config `approvals_reviewer`). Those frames carry the action we are
# about to judge as *their* prompt — evaluating them would double-report every
# action with the reviewer's rubric as the "user turn". Skip them wholesale.
CODEX_REVIEW_MODEL = "codex-auto-review"

# Item types carrying a tool the model wants to run. Codex >= 0.14 emits
# `custom_tool_call` (freeform: `input` is JS driving `tools.exec_command`);
# the classic Responses function tool is `function_call` (`arguments` is JSON).
_TOOL_CALL_ITEMS = ("custom_tool_call", "function_call")
_TOOL_OUTPUT_ITEMS = ("custom_tool_call_output", "function_call_output")

# Field caps from the runtime's guardEventExtSchema (authzEnvelopeSchema). The
# runtime rejects the whole event with `invalid_event` when one is exceeded, so
# truncate here rather than lose the verdict.
MAX_TRANSCRIPT_ENTRIES = 128
MAX_TRANSCRIPT_TEXT = 8192
MAX_SYSTEM_PROMPT = 16384


def is_codex_ws(path: str) -> bool:
    return CODEX_WS_PATH in (path or "")


def codex_frame(text: str) -> dict | None:
    """Parse a Codex WebSocket text frame; None when it is not a JSON object or
    belongs to Codex's own action reviewer."""
    try:
        d = json.loads(text)
    except (ValueError, TypeError):
        return None
    if not isinstance(d, dict):
        return None
    if d.get("model") == CODEX_REVIEW_MODEL:
        return None
    return d


def _turn_id(item: dict) -> str | None:
    meta = (item.get("metadata")
            or item.get("internal_chat_message_metadata_passthrough") or {})
    return meta.get("turn_id")


def parse_codex_ws_user(text: str) -> tuple[str, str | None] | None:
    """Parse a client→server `response.create` frame -> (latest_user_text, turn_id),
    or None if the frame carries no user turn."""
    d = codex_frame(text)
    if d is None or d.get("type") != "response.create":
        return None
    latest, turn_id = "", None
    for it in d.get("input", []):
        if not isinstance(it, dict) or it.get("role") != "user":
            continue
        t = _content_text(it.get("content"))
        if t:
            latest = t
            turn_id = _turn_id(it) or turn_id
    return (latest, turn_id) if latest else None


def parse_codex_ws_tool_call(d: dict) -> dict | None:
    """Parse a server→client `response.output_item.done` frame carrying a
    COMPLETED tool call -> {name, arguments, call_id, turn_id}, else None.

    This is the enforcement point for `tool_call`: the frame is the model
    telling Codex to run something, and mitmproxy awaits this hook before
    forwarding it, so a verdict can still stop the call from ever reaching
    the agent. (The client→server side only ever carries the *result*: Codex
    threads history server-side via `previous_response_id` and never re-sends
    the call itself.)"""
    if d.get("type") != "response.output_item.done":
        return None
    item = d.get("item")
    if not isinstance(item, dict) or item.get("type") not in _TOOL_CALL_ITEMS:
        return None
    args = item.get("input")
    if args is None:
        args = item.get("arguments")
    return {
        "name": item.get("name") or "tool",
        "arguments": args if isinstance(args, str) else json.dumps(args or {}),
        "call_id": item.get("call_id") or item.get("id") or "",
        "turn_id": _turn_id(item),
    }


def is_codex_tool_input_delta(d: dict) -> bool:
    """Incremental tool-call streaming (`…input.delta` / `…arguments.delta`).
    These reach the agent BEFORE the completed item we gate on, so they are
    withheld until the verdict lands — otherwise Codex could assemble and run
    the call out from under the guardrail."""
    t = d.get("type") or ""
    return t.endswith("custom_tool_call_input.delta") or t.endswith(
        "function_call_arguments.delta")


def parse_codex_ws_tool_outputs(d: dict) -> list[dict]:
    """Tool results Codex sends back inside the next `response.create` frame ->
    [{call_id, text}]. This is the `tool_result` surface — untrusted content
    entering the context, which is what the indirect-injection judge reads."""
    if d.get("type") != "response.create":
        return []
    out = []
    for it in d.get("input", []):
        if not isinstance(it, dict) or it.get("type") not in _TOOL_OUTPUT_ITEMS:
            continue
        text = _content_text(it.get("output"))
        if text:
            out.append({"call_id": it.get("call_id") or "", "text": text})
    return out


def parse_codex_ws_system_prompt(d: dict) -> str:
    """Codex's own instructions (developer-role turns + top-level `instructions`)
    — the agent_system_prompt slot of the authz envelope: trusted configuration
    the scope judge weighs a proposed action against."""
    if d.get("type") != "response.create":
        return ""
    parts = []
    if isinstance(d.get("instructions"), str):
        parts.append(d["instructions"])
    for it in d.get("input", []):
        if isinstance(it, dict) and it.get("role") == "developer":
            t = _content_text(it.get("content"))
            if t:
                parts.append(t)
    return "\n\n".join(parts)[:MAX_SYSTEM_PROMPT]


def block_message(reason: str) -> str:
    """User-facing text Codex shows in place of a blocked command's output."""
    return (f"⛔ OpenGuardrails blocked this action (policy: {reason}). "
            "The command was NOT executed.")


def rewrite_codex_tool_call_block(frame: dict, reason: str) -> bytes | None:
    """Turn a blocked `custom_tool_call` frame into a harmless one that surfaces
    the block, instead of dropping it and killing the socket.

    Codex's freeform exec tool runs the item's `input` as JS in its sandbox and
    reports whatever `text(...)` emits. Rewriting `input` to a bare `text(<reason>)`
    — no `exec_command` — means Codex "runs" the call, gets the block notice as the
    tool result, and relays it to the user in its own words. The dangerous command
    never executes, and the turn completes cleanly (no dropped frame, no dead
    socket). The item id / call_id / type are preserved so Codex's state machine,
    which already saw this item's `output_item.added`, stays consistent.

    Returns the mutated frame bytes, or None when the frame is not a rewritable
    `custom_tool_call` (e.g. a named `function_call`, where a rewritten argument
    would still invoke the real tool — the caller must drop those instead)."""
    item = frame.get("item")
    if not isinstance(item, dict) or item.get("type") != "custom_tool_call":
        return None
    payload = json.dumps(block_message(reason))
    item["input"] = f"text({payload})\n"
    return json.dumps(frame).encode("utf-8")


def transcript_entry(role: str, *, text: str = "", tool_name: str = "",
                     tool_input: str = "") -> dict:
    """One authz-envelope transcript entry, capped to the runtime's limits.
    Deliberately carries only user text and tool_use projections — never the
    agent's prose (the judge is reasoning-blind by design)."""
    if tool_name:
        return {"role": role, "tool_use": {"name": tool_name[:128],
                                           "input": tool_input[:MAX_TRANSCRIPT_TEXT]}}
    return {"role": role, "text": text[:MAX_TRANSCRIPT_TEXT]}


def reasons(verdict: dict) -> str:
    rs = verdict.get("reasons") or []
    if rs:
        return "; ".join(rs)
    cats = verdict.get("categories") or verdict.get("findings") or []
    ids = [c.get("id") or c.get("category") for c in cats if isinstance(c, dict)]
    return ", ".join(x for x in ids if x) or "policy violation"


def _categories(verdict: dict) -> list[dict]:
    out = []
    for c in verdict.get("categories") or []:
        out.append({"id": c.get("id"), "domain": c.get("domain"), "score": c.get("score")})
    return out


def block_response(proto: str, reason: str, verdict: dict) -> http.Response:
    """Protocol-correct error body so the caller sees a clean, typed refusal.
    require_approval -> 409, everything else blocking -> 403."""
    decision = verdict.get("decision", "block")
    status = 409 if decision == "require_approval" else 403
    ogr = {"decision": decision, "guard_id": verdict.get("guard_id"),
           "categories": _categories(verdict)}
    prefix = ("Human approval required by OpenGuardrails policy: "
              if decision == "require_approval"
              else "Blocked by OpenGuardrails policy: ")
    headers = {
        "x-ogr-decision": decision,
        "x-ogr-guard-id": str(verdict.get("guard_id") or ""),
    }
    if proto == "anthropic.messages":
        body = {"type": "error", "error": {
            "type": "ogr_policy_block" if status == 403 else "ogr_approval_required",
            "message": prefix + reason, "ogr": ogr}}
    else:  # openai.chat / openai.responses
        body = {"error": {
            "message": prefix + reason,
            "type": "ogr_policy_block" if status == 403 else "ogr_approval_required",
            "code": "guardrails_blocked" if status == 403 else "guardrails_require_approval",
            "ogr": ogr}}
    return http.Response.make(
        status,
        json.dumps(body).encode("utf-8"),
        {"content-type": "application/json", **headers},
    )
