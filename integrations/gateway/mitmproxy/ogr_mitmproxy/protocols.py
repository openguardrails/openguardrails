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


def is_codex_ws(path: str) -> bool:
    return CODEX_WS_PATH in (path or "")


def parse_codex_ws_user(text: str) -> tuple[str, str | None] | None:
    """Parse a client→server `response.create` frame -> (latest_user_text, turn_id),
    or None if the frame carries no user turn."""
    try:
        d = json.loads(text)
    except (ValueError, TypeError):
        return None
    if d.get("type") != "response.create":
        return None
    latest, turn_id = "", None
    for it in d.get("input", []):
        if not isinstance(it, dict) or it.get("role") != "user":
            continue
        t = _content_text(it.get("content"))
        if t:
            latest = t
            meta = it.get("internal_chat_message_metadata_passthrough") or {}
            turn_id = meta.get("turn_id") or turn_id
    return (latest, turn_id) if latest else None


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
