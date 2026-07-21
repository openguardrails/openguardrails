"""Wire-protocol adapters: OpenAI Chat Completions / Responses, Anthropic Messages.

Extract the moderatable text from a request (the latest user turn) and a response
(the completion), and mint a protocol-correct block response so a blocked flow
looks like a normal API error to the caller. Mirrors the shapes used by the
in-process reference gateway (integrations/gateway/openai-anthropic).
"""
from __future__ import annotations

import hashlib
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


def user_messages(proto: str, body: dict) -> list[str]:
    """User-role text in conversation order, for Hermes fallback correlation."""
    return [
        text
        for message in _messages(proto, body)
        if isinstance(message, dict) and message.get("role") == "user"
        for text in [_content_text(message.get("content"))]
        if text
    ]


def is_transcript_helper_request(proto: str, body: dict) -> bool:
    """Recognize Hermes title/summary prompts that replay a finished exchange.

    These auxiliary calls run outside the primary conversation loop and should
    not become Runs. Keep the predicate deliberately narrow: a single user
    message formatted as a User/Assistant transcript and no declared tools.
    """
    users = user_messages(proto, body)
    if len(users) != 1 or body.get("tools"):
        return False
    text = users[0].lstrip()
    return text.startswith("User:") and "\n\nAssistant:" in text


def session_id_from_request(headers: Any, body: dict) -> str:
    """Extract an existing provider/client conversation identifier.

    Hermes/provider combinations expose the value under different ordinary
    fields. This is request parsing, not a requirement for custom OGR headers.
    """
    header_names = (
        "x-session-id",
        "x-conversation-id",
        "x-grok-conv-id",
    )
    for name in header_names:
        value = headers.get(name) if headers is not None else None
        if isinstance(value, str) and value.strip():
            return value.strip()

    containers = [body]
    for key in ("metadata", "extra_body"):
        nested = body.get(key)
        if isinstance(nested, dict):
            containers.append(nested)
    for container in containers:
        for key in ("session_id", "sessionId", "prompt_cache_key"):
            value = container.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
    return ""


def model_input_payload(proto: str, body: dict) -> dict:
    """Complete request content stored for Explorer's Turn transcript.

    Provider transport options are intentionally omitted; messages,
    instructions, declared tools, and model identity are retained verbatim.
    """
    payload: dict = {"model": body.get("model")}
    if proto == "anthropic.messages":
        payload["system"] = body.get("system")
        payload["messages"] = body.get("messages") or []
    elif proto == "openai.responses":
        payload["instructions"] = body.get("instructions")
        payload["input"] = body.get("input", body.get("messages", []))
    else:
        payload["messages"] = body.get("messages") or []
    if body.get("tools") is not None:
        payload["tools"] = body["tools"]
    for key in ("session_id", "sessionId", "prompt_cache_key"):
        if body.get(key) is not None:
            payload[key] = body[key]
    return {k: v for k, v in payload.items() if v is not None}


def request_signature(proto: str, body: dict) -> str:
    """Stable digest of a model request's conversation.

    Agents retry a failed provider call (429/403/5xx) by resending the exact
    same request. That retry is the SAME model roundtrip, so it must not
    advance the Turn counter — this digest is how the lifecycle inference
    recognises it.
    """
    payload = json.dumps(_messages(proto, body), sort_keys=True,
                         ensure_ascii=False, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def request_tool_results(proto: str, body: dict) -> list[dict]:
    """Tool results present in a model request, normalized without truncation."""
    results: list[dict] = []
    if proto == "anthropic.messages":
        for message in body.get("messages") or []:
            if not isinstance(message, dict):
                continue
            content = message.get("content")
            blocks = content if isinstance(content, list) else []
            for block in blocks:
                if not isinstance(block, dict) or block.get("type") != "tool_result":
                    continue
                results.append({
                    "name": block.get("name") or "tool",
                    "call_id": block.get("tool_use_id") or "",
                    "result": block.get("content"),
                })
        return results

    items = body.get("input") if proto == "openai.responses" else body.get("messages")
    for item in items or []:
        if not isinstance(item, dict):
            continue
        item_type = item.get("type")
        if item_type in _TOOL_OUTPUT_ITEMS:
            results.append({
                "name": item.get("name") or "tool",
                "call_id": item.get("call_id") or "",
                "result": item.get("output"),
            })
        elif item.get("role") == "tool":
            results.append({
                "name": item.get("name") or "tool",
                "call_id": item.get("tool_call_id") or item.get("call_id") or "",
                "result": item.get("content"),
            })
    return results


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


def response_payload(proto: str, body: dict) -> dict:
    """Complete assistant response payload for Explorer."""
    if proto == "anthropic.messages":
        return {
            k: v for k, v in {
                "model": body.get("model"),
                "content": body.get("content") or [],
                "stop_reason": body.get("stop_reason"),
                "usage": body.get("usage"),
            }.items() if v is not None
        }
    if proto == "openai.responses":
        return {
            k: v for k, v in {
                "model": body.get("model"),
                "output": body.get("output") or [],
                "output_text": body.get("output_text"),
                "usage": body.get("usage"),
                "status": body.get("status"),
            }.items() if v is not None
        }
    choices = body.get("choices") or []
    choice = choices[0] if choices and isinstance(choices[0], dict) else {}
    message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
    return {
        k: v for k, v in {
            "model": body.get("model"),
            "content": message.get("content"),
            "reasoning_content": message.get("reasoning_content"),
            "tool_calls": message.get("tool_calls") or [],
            "finish_reason": choice.get("finish_reason"),
            "usage": body.get("usage"),
        }.items() if v is not None
    }


def tool_calls_from_response(proto: str, body: dict) -> list[dict]:
    """Every completed assistant tool call in a buffered provider response."""
    if proto == "openai.responses":
        calls = []
        for call in tool_calls_from_output(body):
            calls.append({
                "name": call["name"],
                "arguments": _json_or_text(call["arguments"]),
                "call_id": call["call_id"],
            })
        return calls
    if proto == "anthropic.messages":
        return [
            {
                "name": block.get("name") or "tool",
                "arguments": block.get("input") or {},
                "call_id": block.get("id") or "",
            }
            for block in body.get("content") or []
            if isinstance(block, dict) and block.get("type") == "tool_use"
        ]

    choices = body.get("choices") or []
    choice = choices[0] if choices and isinstance(choices[0], dict) else {}
    message = choice.get("message") if isinstance(choice.get("message"), dict) else {}
    calls = []
    for item in message.get("tool_calls") or []:
        if not isinstance(item, dict):
            continue
        function = item.get("function") if isinstance(item.get("function"), dict) else {}
        calls.append({
            "name": function.get("name") or item.get("name") or "tool",
            "arguments": _json_or_text(function.get("arguments", item.get("arguments"))),
            "call_id": item.get("id") or item.get("call_id") or "",
        })
    return calls


def _json_or_text(value: Any) -> Any:
    if not isinstance(value, str):
        return value if value is not None else {}
    try:
        return json.loads(value)
    except ValueError:
        return value


def parse_sse_response(proto: str, text: str) -> dict:
    """Reconstruct a buffered streaming response into its non-streaming shape."""
    frames = []
    for raw in _sse_data(text):
        if raw == "[DONE]":
            continue
        try:
            frame = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if isinstance(frame, dict):
            frames.append(frame)

    if proto == "anthropic.messages":
        return _anthropic_sse_body(frames)
    if proto == "openai.responses":
        return _responses_sse_body(frames)
    return _openai_chat_sse_body(frames)


def _sse_data(text: str) -> list[str]:
    values: list[str] = []
    data_lines: list[str] = []
    for line in text.splitlines():
        if line.startswith("data:"):
            data_lines.append(line[len("data:"):].lstrip())
        elif not line.strip() and data_lines:
            values.append("\n".join(data_lines))
            data_lines.clear()
    if data_lines:
        values.append("\n".join(data_lines))
    return values


def _openai_chat_sse_body(frames: list[dict]) -> dict:
    text_parts: list[str] = []
    reasoning_parts: list[str] = []
    tools: dict[int, dict] = {}
    model = None
    usage = None
    finish_reason = None
    for frame in frames:
        model = frame.get("model") or model
        usage = frame.get("usage") or usage
        choices = frame.get("choices") or []
        if not choices or not isinstance(choices[0], dict):
            continue
        choice = choices[0]
        finish_reason = choice.get("finish_reason") or finish_reason
        delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
        if isinstance(delta.get("content"), str):
            text_parts.append(delta["content"])
        if isinstance(delta.get("reasoning_content"), str):
            reasoning_parts.append(delta["reasoning_content"])
        for fragment in delta.get("tool_calls") or []:
            if not isinstance(fragment, dict):
                continue
            index = int(fragment.get("index") or 0)
            target = tools.setdefault(index, {
                "id": "",
                "type": fragment.get("type") or "function",
                "function": {"name": "", "arguments": ""},
            })
            target["id"] += fragment.get("id") or ""
            function = fragment.get("function") if isinstance(fragment.get("function"), dict) else {}
            target["function"]["name"] += function.get("name") or ""
            target["function"]["arguments"] += function.get("arguments") or ""
    message = {
        "role": "assistant",
        "content": "".join(text_parts) or None,
        "tool_calls": [tools[index] for index in sorted(tools)],
    }
    reasoning = "".join(reasoning_parts)
    if reasoning:
        message["reasoning_content"] = reasoning
    return {
        "model": model,
        "choices": [{"message": message, "finish_reason": finish_reason}],
        "usage": usage,
    }


def _anthropic_sse_body(frames: list[dict]) -> dict:
    model = None
    usage: dict = {}
    stop_reason = None
    blocks: dict[int, dict] = {}
    for frame in frames:
        frame_type = frame.get("type")
        if frame_type == "message_start":
            message = frame.get("message") or {}
            model = message.get("model")
            usage.update(message.get("usage") or {})
        elif frame_type == "content_block_start":
            index = int(frame.get("index") or 0)
            block = frame.get("content_block") or {}
            blocks[index] = dict(block)
            if block.get("type") == "tool_use":
                blocks[index].setdefault("input_json", "")
        elif frame_type == "content_block_delta":
            index = int(frame.get("index") or 0)
            delta = frame.get("delta") or {}
            block = blocks.setdefault(index, {"type": "text", "text": ""})
            if delta.get("type") == "text_delta":
                block["text"] = str(block.get("text") or "") + str(delta.get("text") or "")
            elif delta.get("type") == "input_json_delta":
                block["input_json"] = str(block.get("input_json") or "") + str(
                    delta.get("partial_json") or ""
                )
        elif frame_type == "message_delta":
            delta = frame.get("delta") or {}
            stop_reason = delta.get("stop_reason") or stop_reason
            usage.update(frame.get("usage") or {})
    content = []
    for index in sorted(blocks):
        block = blocks[index]
        if block.get("type") == "tool_use":
            raw = block.pop("input_json", "")
            block["input"] = _json_or_text(raw)
        content.append(block)
    return {"model": model, "content": content, "stop_reason": stop_reason, "usage": usage}


def _responses_sse_body(frames: list[dict]) -> dict:
    completed = next(
        (frame.get("response") for frame in reversed(frames)
         if frame.get("type") == "response.completed" and isinstance(frame.get("response"), dict)),
        None,
    )
    if completed is not None:
        return completed
    output = [
        frame["item"]
        for frame in frames
        if frame.get("type") == "response.output_item.done"
        and isinstance(frame.get("item"), dict)
    ]
    text = "".join(
        str(frame.get("delta") or "")
        for frame in frames
        if frame.get("type") == "response.output_text.delta"
    )
    return {"output": output, "output_text": text or None}


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


def is_codex_http(path: str) -> bool:
    """Same URL as `is_codex_ws` — chatgpt.com/backend-api/codex/responses
    serves both transports. codex-cli (Rust, WebSocket) and third-party
    clients built on the openai SDK (plain HTTPS POST, e.g. hermes-agent)
    hit the identical path; the addon tells them apart by hook (WS frames
    only ever reach `websocket_message`) and HTTP method (a WS handshake is
    a GET, a Responses API call is always a POST) rather than by path."""
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


def _tool_call_item(item: Any) -> dict | None:
    """{name, arguments, call_id, turn_id} from a completed output item, or
    None if `item` isn't a tool call. Shared by the WebSocket per-frame path
    and the buffered-HTTP paths (non-streaming `output[]`, SSE events) — the
    underlying Responses API item shape is identical across all three
    transports, only the framing around it differs."""
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


def parse_codex_ws_tool_call(d: dict) -> dict | None:
    """Parse a server→client `response.output_item.done` frame carrying a
    COMPLETED tool call -> {name, arguments, call_id, turn_id}, else None.

    This is the enforcement point for `tool_call`: the frame is the model
    telling Codex to run something, and mitmproxy awaits this hook before
    forwarding it, so a verdict can still stop the call from ever reaching
    the agent. (The client→server side only ever carries the *result*: Codex
    threads history server-side via `previous_response_id` and never re-sends
    the call itself.)

    The identical `response.output_item.done` event also appears verbatim as
    an SSE `data:` payload for HTTP+SSE Codex clients (see `parse_sse_events`)
    — same parser, different transport."""
    if d.get("type") != "response.output_item.done":
        return None
    return _tool_call_item(d.get("item"))


def tool_calls_from_output(body: dict) -> list[dict]:
    """Every completed tool call in a non-streaming Responses API `output[]`
    array — the buffered-JSON counterpart of `parse_codex_ws_tool_call` for
    HTTP+SSE Codex clients (see `protocols.is_codex_http`) that call with
    `stream=false`. A plain HTTP response carries the whole turn's output at
    once instead of one `output_item.done` frame at a time."""
    calls = []
    for item in body.get("output") or []:
        call = _tool_call_item(item)
        if call:
            calls.append(call)
    return calls


def parse_sse_events(text: str) -> list[dict]:
    """Split a buffered `text/event-stream` body into its `data:` JSON
    payloads (skipping the terminal `[DONE]` marker and Codex's own
    auto-reviewer frames, via `codex_frame`).

    mitmproxy buffers the whole response before the `response` hook fires
    (no `stream_large_bodies` opt-in here), so by the time this runs every
    event for the turn is already in `text` and nothing has reached the
    client yet — the same enforcement window the WebSocket path gets from
    awaiting `websocket_message` before forwarding a frame."""
    events: list[dict] = []
    data_lines: list[str] = []

    def _flush() -> None:
        if not data_lines:
            return
        raw = "\n".join(data_lines)
        data_lines.clear()
        if raw == "[DONE]":
            return
        frame = codex_frame(raw)
        if frame is not None:
            events.append(frame)

    for line in text.split("\n"):
        line = line.rstrip("\r")
        if line.startswith("data:"):
            data_lines.append(line[len("data:"):].lstrip())
        elif line == "":
            _flush()
    _flush()
    return events


def parse_codex_http_input(body: dict) -> dict:
    """Everything the OGR gateway needs from a plain-HTTP Codex Responses API
    request body (e.g. hermes-agent: the openai SDK against
    chatgpt.com/backend-api/codex, no WS envelope).

    These callers set `store: false`, so Codex never threads history via
    `previous_response_id` for them — the full turn history is resent in
    `input[]` on every request. That means (unlike the WebSocket path) there
    is no per-connection state to accumulate: the transcript below is
    rebuilt fresh from this one body. The caller still needs to dedup
    `tool_outputs` against what it already judged for this session, since
    the same historical tool results reappear on every later turn.

    -> {latest_user, system_prompt, transcript, tool_outputs, session_hint}"""
    latest_user = ""
    transcript: list[dict] = []
    tool_outputs: list[dict] = []
    for item in body.get("input") or []:
        if not isinstance(item, dict):
            continue
        item_type = item.get("type")
        if item_type in _TOOL_CALL_ITEMS:
            call = _tool_call_item(item)
            if call:
                transcript.append(transcript_entry(
                    "assistant", tool_name=call["name"], tool_input=call["arguments"]))
            continue
        if item_type in _TOOL_OUTPUT_ITEMS:
            text = _content_text(item.get("output"))
            if text:
                tool_outputs.append({"call_id": item.get("call_id") or "", "text": text})
            continue
        if item.get("role") != "user":
            continue
        text = _content_text(item.get("content"))
        if text:
            latest_user = text
            transcript.append(transcript_entry("user", text=text))

    session_hint = body.get("prompt_cache_key")
    return {
        "latest_user": latest_user,
        "system_prompt": str(body.get("instructions") or "")[:MAX_SYSTEM_PROMPT],
        "transcript": transcript[-MAX_TRANSCRIPT_ENTRIES:],
        "tool_outputs": tool_outputs,
        "session_hint": session_hint if isinstance(session_hint, str) and session_hint else None,
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


def wants_stream(body: dict) -> bool:
    """Did the client ask for a streamed response? (`stream: true` — codex /
    responses agents do.) Decides 代答 SSE vs buffered JSON."""
    return bool(isinstance(body, dict) and body.get("stream"))


def moderation_answer(verdict: dict) -> str | None:
    """The substitute-answer text (代答) for a block that came from the
    `moderation` guardrail, else None.

    A content-moderation block carries the model's polite refusal in its
    finding description (the runtime's Xiangxin demo backend puts the API's
    `suggest_answer` there, surfaced through `reasons`). When the block is a
    moderation hit we return that text so the gateway can hand it back AS THE
    MODEL'S REPLY instead of an API error. Non-moderation blocks (command
    danger, injection, a tool gate) return None → ordinary `block_response`.
    """
    findings = verdict.get("findings") or []
    if not any(isinstance(f, dict) and f.get("detector") == "moderation"
               for f in findings):
        return None
    for r in verdict.get("reasons") or []:
        if isinstance(r, str) and r.startswith("moderation."):
            # strip the "moderation.<check_id>: " prefix → just the refusal.
            _, sep, rest = r.partition(": ")
            return rest if sep and rest.strip() else r
    return reasons(verdict)


def block_answer_text(verdict: dict) -> str:
    """A user-facing reason for a NON-moderation block, handed to the agent as
    the model's reply so a coding agent degrades gracefully (gets a reason it
    can act on) instead of a hard 403. Strips the internal
    "guardrail.check_id: " prefixes from the reasons for readability."""
    parts: list[str] = []
    for r in verdict.get("reasons") or []:
        if not isinstance(r, str):
            continue
        _, sep, rest = r.partition(": ")
        parts.append(rest if sep and rest.strip() else r)
    detail = " ".join(parts).strip() or reasons(verdict)
    return ("I can't proceed with that — it was blocked by an OpenGuardrails "
            f"security policy. Reason: {detail}")


def answer_response(
    proto: str, text: str, verdict: dict, streaming: bool = False,
) -> http.Response:
    """A 200 completion impersonating the model whose assistant text is
    `text` (代答). Used when a moderation block should reach the agent as the
    model's own reply, not an error. Emits SSE when the client asked for a
    stream (agents over the codex/responses endpoint do), else buffered JSON.
    """
    # Responses clients persist output items and send them back in a later
    # input[]. The Codex endpoint validates these opaque IDs by kind, so our
    # synthetic answer must use the same prefixes as native Responses objects.
    # (An `ogrmsg-*` item is rejected with "Expected an ID that begins with
    # 'msg'" on the next turn.)
    if proto == "openai.responses":
        mid = new_id("msg")
        rid = new_id("resp")
    else:
        mid = new_id("ogrmsg")
        rid = new_id("ogrresp")
    headers = {
        "x-ogr-decision": "block",
        "x-ogr-answer": "1",
        "x-ogr-guard-id": str(verdict.get("guard_id") or ""),
    }
    if streaming:
        return http.Response.make(
            200,
            _answer_sse(proto, text, mid, rid).encode("utf-8"),
            {"content-type": "text/event-stream", **headers},
        )
    if proto == "anthropic.messages":
        body: dict = {
            "id": mid, "type": "message", "role": "assistant",
            "model": "openguardrails", "stop_reason": "end_turn",
            "content": [{"type": "text", "text": text}],
            "usage": {"input_tokens": 0, "output_tokens": 0},
        }
    elif proto == "openai.responses":
        body = {
            "id": rid, "object": "response", "status": "completed",
            "output": [{"id": mid, "type": "message", "role": "assistant",
                        "content": [{"type": "output_text", "text": text}]}],
            "output_text": text,
        }
    else:  # openai.chat
        body = {
            "id": rid, "object": "chat.completion", "model": "openguardrails",
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": text}}],
        }
    return http.Response.make(
        200, json.dumps(body).encode("utf-8"),
        {"content-type": "application/json", **headers},
    )


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def _answer_sse(proto: str, text: str, mid: str, rid: str) -> str:
    """A minimal but SDK-valid SSE stream carrying `text` as one assistant
    message, in the event vocabulary each protocol's client expects."""
    if proto == "anthropic.messages":
        return (
            _sse("message_start", {"type": "message_start", "message": {
                "id": mid, "type": "message", "role": "assistant",
                "model": "openguardrails", "content": [],
                "usage": {"input_tokens": 0, "output_tokens": 0}}})
            + _sse("content_block_start", {"type": "content_block_start",
                   "index": 0, "content_block": {"type": "text", "text": ""}})
            + _sse("content_block_delta", {"type": "content_block_delta",
                   "index": 0, "delta": {"type": "text_delta", "text": text}})
            + _sse("content_block_stop", {"type": "content_block_stop", "index": 0})
            + _sse("message_delta", {"type": "message_delta",
                   "delta": {"stop_reason": "end_turn"}})
            + _sse("message_stop", {"type": "message_stop"})
        )
    if proto == "openai.responses":
        msg = {"id": mid, "type": "message", "role": "assistant",
               "content": [{"type": "output_text", "text": text}]}
        resp_done = {"id": rid, "object": "response", "status": "completed",
                     "output": [msg], "output_text": text}
        return (
            _sse("response.created", {"type": "response.created", "response": {
                "id": rid, "object": "response", "status": "in_progress", "output": []}})
            + _sse("response.output_item.added", {"type": "response.output_item.added",
                   "output_index": 0, "item": {"id": mid, "type": "message",
                   "role": "assistant", "content": []}})
            + _sse("response.content_part.added", {"type": "response.content_part.added",
                   "item_id": mid, "output_index": 0, "content_index": 0,
                   "part": {"type": "output_text", "text": ""}})
            + _sse("response.output_text.delta", {"type": "response.output_text.delta",
                   "item_id": mid, "output_index": 0, "content_index": 0, "delta": text})
            + _sse("response.output_text.done", {"type": "response.output_text.done",
                   "item_id": mid, "output_index": 0, "content_index": 0, "text": text})
            + _sse("response.output_item.done", {"type": "response.output_item.done",
                   "output_index": 0, "item": msg})
            + _sse("response.completed", {"type": "response.completed",
                   "response": resp_done})
        )
    # openai.chat
    chunk = {"id": rid, "object": "chat.completion.chunk", "model": "openguardrails",
             "choices": [{"index": 0, "delta": {"role": "assistant", "content": text},
                          "finish_reason": None}]}
    done = {"id": rid, "object": "chat.completion.chunk", "model": "openguardrails",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
    return (f"data: {json.dumps(chunk)}\n\n"
            f"data: {json.dumps(done)}\n\n"
            "data: [DONE]\n\n")
