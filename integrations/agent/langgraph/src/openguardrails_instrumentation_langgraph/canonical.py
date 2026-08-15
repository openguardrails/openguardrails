"""LangChain messages → the OGR canonical payload shape.

A LangGraph agent holds no raw provider body — the chat-model client owns
the HTTP exchange — so this integration speaks ``llm_protocol: "canonical"``
(guard-event.md § canonical payloads): ``{messages, tools?}`` before the
call, ``{text?, reasoning?, tool_calls?, model?, usage?, timing?}`` after.

Everything here DUCK-TYPES the langchain-core message surface (``.type``,
``.content``, ``.tool_calls``, ``.tool_call_id``, ``.usage_metadata``,
``.response_metadata``) instead of importing it. That is deliberate: the
package stays importable — and fully testable — without langchain installed,
and there is no pinned import to drift against.

Faithfulness rules (guard-event.md): the conversion never DECOMPOSES. The
system prompt stays ``messages[0]`` with role ``system``; tool results stay
the tool-role messages they already are, keyed by the provider's
``tool_call_id``; an assistant turn keeps its prose and ALL of its tool
calls in one message. The runtime does the rest.
"""

from __future__ import annotations

from typing import Any

# langchain-core message ``type`` → canonical role. Anything unknown passes
# through unchanged — inventing a role would be a decomposition.
_ROLE_BY_TYPE = {
    "system": "system",
    "human": "user",
    "ai": "assistant",
    "tool": "tool",
}


def _get(obj: Any, key: str, default: Any = None) -> Any:
    """One accessor for both worlds: langchain tool calls are plain dicts,
    messages are objects, and callers may hand us either."""
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _tool_call_to_canonical(tc: Any) -> dict:
    # langchain-core normalizes provider tool calls to {name, args, id};
    # canonical calls them {id, name, arguments} with arguments as an object.
    return {
        "id": _get(tc, "id") or "",
        "name": _get(tc, "name") or "",
        "arguments": _get(tc, "args") if _get(tc, "args") is not None else {},
    }


def message_to_canonical(msg: Any) -> dict:
    """One LangChain (or already-dict) message → one canonical message."""
    if isinstance(msg, dict) and "role" in msg:
        return msg  # already canonical-shaped; forward untouched
    mtype = _get(msg, "type")
    role = _ROLE_BY_TYPE.get(mtype, mtype or "user")
    out: dict = {"role": role, "content": _get(msg, "content", "")}
    if role == "assistant":
        tool_calls = _get(msg, "tool_calls")
        if tool_calls:
            out["tool_calls"] = [_tool_call_to_canonical(tc) for tc in tool_calls]
    if role == "tool":
        # The id is how the runtime pairs this result with its call.
        out["tool_call_id"] = _get(msg, "tool_call_id") or ""
    return out


def tool_to_canonical(tool: Any) -> Any:
    """One declared tool → its canonical schema entry.

    Tool DEFINITIONS are themselves an attack surface (description
    injection, rug-pulls), so the declared inventory travels on every
    step/request. A dict (an OpenAI-style schema the caller already built)
    is forwarded untouched; a BaseTool-like object contributes its name,
    description and argument schema.
    """
    if isinstance(tool, dict):
        return tool
    entry: dict = {"name": _get(tool, "name") or ""}
    description = _get(tool, "description")
    if description:
        entry["description"] = description
    args = _get(tool, "args")  # BaseTool.args: the JSON-schema properties dict
    if isinstance(args, dict) and args:
        entry["parameters"] = args
    return entry


def request_payload(messages: list, tools: list | None) -> dict:
    """The canonical step/request body: the FULL conversation about to be
    sent (the wire is deliberately stateless and repetitive), plus the tool
    inventory when this integration knows it."""
    payload: dict = {"messages": [message_to_canonical(m) for m in messages]}
    if tools:
        payload["tools"] = [tool_to_canonical(t) for t in tools]
    return payload


def _split_content(content: Any) -> tuple[str | None, str | None]:
    """An AIMessage's content is a string, or a list of provider blocks.
    Pull out prose and reasoning without inventing either: absent is absent."""
    if isinstance(content, str):
        return (content or None), None
    if isinstance(content, list):
        texts: list[str] = []
        reasonings: list[str] = []
        for block in content:
            if isinstance(block, str):
                texts.append(block)
            elif isinstance(block, dict):
                kind = block.get("type")
                if kind == "text":
                    texts.append(block.get("text", ""))
                elif kind in ("reasoning", "thinking"):
                    reasonings.append(block.get(kind, block.get("text", "")))
        return ("".join(texts) or None), ("".join(reasonings) or None)
    return None, None


def _usage_to_canonical(usage: Any) -> dict | None:
    """Transcribe langchain's usage_metadata into the canonical counters.

    Only what the provider actually reported: the spec says omit the field —
    never fabricate zeros — when nothing was reported, because an
    integration holds no tokenizer and absence is the honest value.
    """
    if not usage:
        return None
    out: dict = {}
    for key in ("input_tokens", "output_tokens"):
        value = _get(usage, key)
        if value is not None:
            out[key] = value
    input_details = _get(usage, "input_token_details") or {}
    if _get(input_details, "cache_read") is not None:
        out["cache_read_tokens"] = _get(input_details, "cache_read")
    if _get(input_details, "cache_creation") is not None:
        out["cache_write_tokens"] = _get(input_details, "cache_creation")
    output_details = _get(usage, "output_token_details") or {}
    if _get(output_details, "reasoning") is not None:
        out["reasoning_tokens"] = _get(output_details, "reasoning")
    return out or None


def response_payload(message: Any, started_at: str, completed_at: str) -> dict:
    """The canonical step/response body for one AIMessage.

    ``timing`` is the wall-clock fact only this integration can supply
    (guard-event.md § usage and timing); ``.invoke`` is a buffered call, so
    there is no ``first_token_at`` to report.
    """
    payload: dict = {}
    text, reasoning = _split_content(_get(message, "content"))
    if text is not None:
        payload["text"] = text
    if reasoning is not None:
        payload["reasoning"] = reasoning
    tool_calls = _get(message, "tool_calls")
    if tool_calls:
        payload["tool_calls"] = [_tool_call_to_canonical(tc) for tc in tool_calls]
    metadata = _get(message, "response_metadata") or {}
    model = _get(metadata, "model_name") or _get(metadata, "model")
    if model:
        payload["model"] = model
    usage = _usage_to_canonical(_get(message, "usage_metadata"))
    if usage:
        payload["usage"] = usage
    payload["timing"] = {"started_at": started_at, "completed_at": completed_at}
    return payload
