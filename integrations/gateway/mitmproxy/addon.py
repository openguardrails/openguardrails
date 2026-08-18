"""OGR v0.8 mitmproxy addon — the gateway recipe on mitmproxy's hooks.

    agent --HTTPS--> mitmproxy (this addon) --> LLM provider
                         │
                         └── GuardEvent → POST {OGR_URL}/v1/evaluate → Verdict

One proxied model call is one STEP, reported as two events that share an
addon-minted `step_id` (specification/runtime-api.md, "The recipe"):

    request hook   step/request   the provider request body, verbatim
    response hook  step/response  the provider response body, verbatim
                                  (stream-reassembled if streamed) + timing

`block` on the request answers the agent with a protocol-shaped error and the
model is never called; `block` on the response withholds the model's answer —
the enforcement moment that matters most, because the tool calls held there
are the only copy of an action anyone can still refuse.

Nothing is decomposed client-side: the runtime derives sessions, turns and
step numbers, classifies the conversation, and judges the tool inventory from
the `tools` array where it already travels. What lives here is only what the
thing in the byte path can do — hold the bytes, enforce the verdict, splice
the redaction spans, reassemble the stream, and render a refusal in the
caller's own protocol.

Streaming: mitmproxy buffers a response in full before the `response` hook
fires (streaming pass-through is an opt-in this addon never opts into), so a
streamed reply is judged ONCE, whole — the spec's tail-hold with tail = ∞.
The client sees nothing of a streamed answer until the verdict allows it;
the accepted cost is time-to-first-token, not exposure.

Run:  OGR_URL=... OGR_API_KEY=ogr_... mitmdump -s addon.py
(every knob is also a mitmproxy option: `--set ogr_fail_mode=closed`.)

The module imports without mitmproxy so the tests can drive the hook logic
with fabricated flow objects; the mitmproxy types are only needed live.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import urllib.request
import uuid
from datetime import datetime, timezone

try:  # absent in the offline test environment — the hooks never touch it there
    from mitmproxy import ctx as _mitm_ctx
    from mitmproxy import http as _mitm_http
except ImportError:  # pragma: no cover - exercised implicitly by the test run
    _mitm_ctx = None
    _mitm_http = None

logger = logging.getLogger("ogr.mitmproxy")

# The integration build id. It left the GuardEvent in v0.8 — it rides ONLY on
# the heartbeat, where fleet coverage and bad-rollout triage read it.
INTEGRATION = "ogr-mitmproxy/1.0.0"

HEARTBEAT_INTERVAL_S = 30


# ── wire helpers ────────────────────────────────────────────────────────────

def match_protocol(path: str) -> str | None:
    """`llm_protocol` from the request path — the producer states the shape it
    is forwarding (guard-event.md § llm_protocol). Suffix match, because the
    canonical provider paths survive arbitrary base-path prefixes."""
    p = path.split("?", 1)[0].rstrip("/")
    if p.endswith("/chat/completions"):
        return "openai.chat"
    if p.endswith("/responses"):
        return "openai.responses"
    if p.endswith("/messages"):
        return "anthropic.messages"
    return None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def splice_timing(payload_text: str, timing: dict) -> str:
    """Insert a top-level `timing` key into a RAW body's own bytes.

    Byte insertion, never re-serialization (guard-event.md § usage and
    timing): verdict span offsets index the payload strings *as transported*,
    and a decode/re-encode could re-escape them. The caller has already
    checked the body carries no `timing` of its own — no provider protocol
    defines one, but if a body has it we must leave it alone."""
    i = payload_text.find("{")
    if i < 0:
        return payload_text
    rest = payload_text[i + 1:].lstrip()
    sep = "" if rest.startswith("}") else ", "
    return (payload_text[:i + 1]
            + '"timing": ' + json.dumps(timing) + sep
            + payload_text[i + 1:])


def event_json(kind: str, step_id: str, identity: dict, llm_protocol: str,
               payload_text: str) -> bytes:
    """Serialize a GuardEvent AROUND the payload text.

    The envelope is ours to encode; the payload is the provider's body spliced
    in verbatim, so the event carries the strings exactly as transported. The
    v0.8 event is those nine required fields plus `integration` (restored
    2026-08-17 as the one optional field) — no ogr_version, no coordinates, no
    timestamp (guard-event.md § what v0.8 removed)."""
    head = json.dumps({"kind": kind, "step_id": step_id, **identity,
                       "llm_protocol": llm_protocol,
                       # WHO REPORTED IT — the one OPTIONAL v0.8 field, and the SAME
                       # constant the heartbeat sends (two literals would drift and
                       # each would look right alone). Stamped in this ONE builder so
                       # it cannot go missing on one kind of event only.
                       "integration": INTEGRATION}, ensure_ascii=False)
    return (head[:-1] + ', "payload": ' + payload_text + "}").encode("utf-8")


def post_json(url: str, api_key: str, data: bytes, timeout: float) -> dict | None:
    """One authenticated POST; a dict back, or None. A 200 whose body is not
    an object is a failure, not an allow — an empty body or an HTML error
    page must land in the fail mode, never pass as a verdict."""
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {api_key}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - operator-configured URL
        body = json.loads(r.read() or b"null")
    return body if isinstance(body, dict) else None


# ── refusals ────────────────────────────────────────────────────────────────

def refusal_body(llm_protocol: str, message: str) -> dict:
    """A refusal in the CALLER's protocol — a refused Anthropic caller gets an
    Anthropic-shaped error, an OpenAI caller an OpenAI-shaped one."""
    if llm_protocol == "anthropic.messages":
        return {"type": "error",
                "error": {"type": "forbidden", "message": message}}
    return {"error": {"type": "ogr_policy_block", "code": "guardrails_blocked",
                      "message": message}}


def make_response(status: int, body: dict, headers: dict):
    """Build the flow.response we answer with. Under mitmproxy this is a real
    http.Response; the offline tests get a shape-compatible stand-in so the
    hook logic runs without mitmproxy installed."""
    data = json.dumps(body).encode("utf-8")
    headers = {"content-type": "application/json", **headers}
    if _mitm_http is not None:
        return _mitm_http.Response.make(status, data, headers)

    class _Response:  # duck-types the parts of http.Response the addon reads
        status_code = status

        def __init__(self):
            self.content, self.headers = data, headers

        def get_text(self):
            return data.decode("utf-8")

    return _Response()


# ── redaction: applying the verdict's spans ─────────────────────────────────

def apply_spans(body: dict, spans: list[dict]) -> int:
    """Apply `modifications.spans` in place; return how many did NOT resolve.

    A span names a string inside the body we sent (`payload.messages.3.content`,
    bracket form accepted) plus character offsets and a placeholder. Spans on
    one string apply highest offset first, so a splice cannot shift the
    offsets a later span was computed against. A span that does not resolve —
    unknown path, non-string, offsets out of range — is dropped and COUNTED,
    never applied somewhere else: silent, that disagreement looks exactly
    like a workspace with no redaction policy."""
    unresolved = 0
    groups: dict[tuple, list[dict]] = {}
    for span in spans:
        path = str(span.get("path", ""))
        norm = path.replace("[", ".").replace("]", "")
        parts = [p for p in norm.split(".") if p]
        if not parts or parts[0] != "payload":
            unresolved += 1
            continue
        groups.setdefault(tuple(parts[1:]), []).append(span)

    for parts, group in groups.items():
        parent, key = _resolve(body, parts)
        value = None if parent is None else _index(parent, key)
        if not isinstance(value, str):
            unresolved += len(group)
            continue
        for span in sorted(group, key=lambda s: s.get("start", 0), reverse=True):
            start, end = span.get("start"), span.get("end")
            if (not isinstance(start, int) or not isinstance(end, int)
                    or not 0 <= start <= end <= len(value)):
                unresolved += 1
                continue
            value = value[:start] + str(span.get("replacement", "")) + value[end:]
        parent[key] = value  # dict[str] and list[int] assign the same way
    return unresolved


def _resolve(body, parts: tuple):
    """Walk `parts` to the CONTAINER of the leaf; (None, None) when the path
    names nothing this body holds."""
    node = body
    for token in parts[:-1]:
        node = _index(node, _key(node, token))
        if node is None:
            return None, None
    if not parts:
        return None, None
    return node, _key(node, parts[-1])


def _key(node, token: str):
    return int(token) if isinstance(node, list) and token.lstrip("-").isdigit() else token


def _index(node, key):
    if isinstance(node, dict):
        return node.get(key)
    if isinstance(node, list) and isinstance(key, int) and -len(node) <= key < len(node):
        return node[key]
    return None


# ── stream reassembly (judge once, whole) ───────────────────────────────────

def sse_data_frames(raw: str) -> list[dict]:
    """The parsed `data:` payloads of an SSE stream, in order. Multi-line data
    per the SSE spec (joined with \\n); `[DONE]` and unparseable frames are
    dropped — they carry no content to judge."""
    frames: list[dict] = []
    data_lines: list[str] = []
    for line in raw.split("\n") + [""]:  # trailing "" flushes the last event
        line = line.rstrip("\r")
        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
            continue
        if line == "" and data_lines:
            data = "\n".join(data_lines)
            data_lines = []
            if data.strip() == "[DONE]":
                continue
            try:
                frame = json.loads(data)
            except ValueError:
                continue
            if isinstance(frame, dict):
                frames.append(frame)
    return frames


def _merge_usage(into: dict, new: dict | None) -> None:
    # Anthropic splits usage across message_start/message_delta; merge halves,
    # either half never zeroing the other.
    for k, v in (new or {}).items():
        if v:
            into[k] = v


def canonical_usage(llm_protocol: str, usage: dict) -> dict:
    """Transcribe the provider's counters into the canonical five. Only what
    the provider reported: the gateway holds no tokenizer, and absence is the
    honest value (guard-event.md § usage and timing)."""
    if llm_protocol == "anthropic.messages":
        mapping = {"input_tokens": "input_tokens",
                   "output_tokens": "output_tokens",
                   "cache_read_input_tokens": "cache_read_tokens",
                   "cache_creation_input_tokens": "cache_write_tokens"}
    else:
        mapping = {"prompt_tokens": "input_tokens",
                   "completion_tokens": "output_tokens"}
    out = {canon: usage[raw] for raw, canon in mapping.items()
           if isinstance(usage.get(raw), int)}
    details = usage.get("completion_tokens_details") or {}
    if isinstance(details.get("reasoning_tokens"), int):
        out["reasoning_tokens"] = details["reasoning_tokens"]
    pdetails = usage.get("prompt_tokens_details") or {}
    if isinstance(pdetails.get("cached_tokens"), int):
        out["cache_read_tokens"] = pdetails["cached_tokens"]
    return out


def _parse_arguments(raw: str):
    # The canonical shape carries arguments as an object when they parse;
    # a fragmentary/non-JSON accumulation stays a string rather than lying.
    try:
        parsed = json.loads(raw or "{}")
    except ValueError:
        return raw
    return parsed if isinstance(parsed, (dict, list)) else raw


def reassemble_stream(llm_protocol: str, raw: str) -> tuple[dict | None, str]:
    """One payload from a completed SSE stream: (payload, llm_protocol).

    openai.responses is special: its terminal `response.completed` frame
    carries the COMPLETE raw response object, so a single raw body does exist
    and travels as `openai.responses`. The chat/messages streams have no such
    body — they reassemble into the canonical shape, reported as `canonical`
    with the provider's usage counters transcribed (guard-event.md
    § canonical payloads)."""
    frames = sse_data_frames(raw)
    if not frames:
        return None, llm_protocol
    if llm_protocol == "openai.responses":
        for frame in reversed(frames):
            if frame.get("type") == "response.completed" and isinstance(frame.get("response"), dict):
                return frame["response"], "openai.responses"
        return _reassemble_responses(frames), "canonical"
    if llm_protocol == "anthropic.messages":
        return _reassemble_anthropic(frames), "canonical"
    return _reassemble_openai_chat(frames), "canonical"


def _reassemble_openai_chat(frames: list[dict]) -> dict:
    text: list[str] = []
    reasoning: list[str] = []
    calls: dict[int, dict] = {}
    model, usage = "", {}
    for frame in frames:
        model = frame.get("model") or model
        _merge_usage(usage, frame.get("usage"))
        for choice in frame.get("choices") or []:
            if choice.get("index", 0) != 0:
                continue  # canonical carries one answer; n>1 is not agent traffic
            delta = choice.get("delta") or {}
            if delta.get("content"):
                text.append(delta["content"])
            if delta.get("reasoning_content"):
                reasoning.append(delta["reasoning_content"])
            for tc in delta.get("tool_calls") or []:
                slot = calls.setdefault(tc.get("index", 0),
                                        {"id": "", "name": "", "arguments": ""})
                slot["id"] = tc.get("id") or slot["id"]
                fn = tc.get("function") or {}
                slot["name"] = fn.get("name") or slot["name"]
                slot["arguments"] += fn.get("arguments") or ""
    return _canonical_response(text, reasoning, [calls[i] for i in sorted(calls)],
                               model, usage, "openai.chat")


def _reassemble_anthropic(frames: list[dict]) -> dict:
    text: list[str] = []
    reasoning: list[str] = []
    tools: dict[int, dict] = {}
    model, usage = "", {}
    for frame in frames:
        ftype = frame.get("type")
        if ftype == "message_start":
            message = frame.get("message") or {}
            model = message.get("model") or model
            _merge_usage(usage, message.get("usage"))
        elif ftype == "content_block_start":
            block = frame.get("content_block") or {}
            if block.get("type") == "tool_use":
                tools[frame.get("index", 0)] = {"id": block.get("id", ""),
                                                "name": block.get("name", ""),
                                                "arguments": ""}
        elif ftype == "content_block_delta":
            delta = frame.get("delta") or {}
            if delta.get("type") == "text_delta":
                text.append(delta.get("text", ""))
            elif delta.get("type") == "thinking_delta":
                reasoning.append(delta.get("thinking", ""))
            elif delta.get("type") == "input_json_delta":
                slot = tools.get(frame.get("index", 0))
                if slot is not None:
                    slot["arguments"] += delta.get("partial_json", "")
        elif ftype == "message_delta":
            _merge_usage(usage, frame.get("usage"))
    return _canonical_response(text, reasoning, [tools[i] for i in sorted(tools)],
                               model, usage, "anthropic.messages")


def _reassemble_responses(frames: list[dict]) -> dict:
    # Fallback for a Responses stream whose completed frame was withheld.
    text: list[str] = []
    calls: list[dict] = []
    model, usage = "", {}
    for frame in frames:
        if frame.get("type") == "response.output_text.delta":
            text.append(frame.get("delta", ""))
        elif frame.get("type") == "response.output_item.done":
            item = frame.get("item") or {}
            if item.get("type") == "function_call":
                calls.append({"id": item.get("call_id", ""),
                              "name": item.get("name", ""),
                              "arguments": item.get("arguments", "")})
    return _canonical_response(text, [], calls, model, usage, "openai.chat")


def _canonical_response(text, reasoning, calls, model, usage, llm_protocol) -> dict:
    payload: dict = {"text": "".join(text)}
    if reasoning:
        payload["reasoning"] = "".join(reasoning)
    if calls:
        payload["tool_calls"] = [{"id": c["id"], "name": c["name"],
                                  "arguments": _parse_arguments(c["arguments"])}
                                 for c in calls]
    if model:
        payload["model"] = model
    counters = canonical_usage(llm_protocol, usage)
    if counters:  # MUST omit rather than report zeros the provider never said
        payload["usage"] = counters
    return payload


# ── the addon ───────────────────────────────────────────────────────────────

# (option name, type, env var, default, help) — one table drives the env
# defaults, the mitmproxy option registration, and the README.
_OPTIONS = [
    ("ogr_url", str, "OGR_URL", "http://localhost:3000",
     "OGR runtime base URL; canonical /v1/* paths are joined onto it"),
    ("ogr_api_key", str, "OGR_API_KEY", "",
     "organization API key (Authorization: Bearer)"),
    ("ogr_agent_id", str, "OGR_AGENT_ID", "",
     "four-tuple: WHICH agent fronts this proxy ('' = derived from the API key)"),
    ("ogr_agent_type", str, "OGR_AGENT_TYPE", "",
     "four-tuple: what KIND of agent ('' = unlabeled)"),
    ("ogr_agent_workspace", str, "OGR_AGENT_WORKSPACE", "",
     "four-tuple: agent group / policy set ('' = the key's workspace)"),
    ("ogr_agent_user", str, "OGR_AGENT_USER", "",
     "four-tuple: who uses the agent behind this proxy ('' = one user)"),
    ("ogr_fail_mode", str, "OGR_FAIL_MODE", "open",
     "'open' (default): an unanswered evaluate proceeds, counted unchecked; "
     "'closed': it is refused until the runtime answers again"),
    ("ogr_timeout", float, "OGR_TIMEOUT", 5.0,
     "evaluate budget in seconds — a ceiling for the worst case, not a target"),
]


class OGRGateway:
    """The PEP. All policy lives in the runtime; this class holds bytes and
    enforces verdicts. Configuration is env-first (the table above) with a
    mitmproxy option mirror so `--set ogr_fail_mode=closed` works too."""

    def __init__(self, **overrides) -> None:
        for name, typ, env_var, default, _help in _OPTIONS:
            raw = os.environ.get(env_var)
            setattr(self, name, typ(raw) if raw is not None else default)
        for name, value in overrides.items():
            setattr(self, name, value)
        # Loud degraded-mode signaling (degraded-mode.md): these ride the
        # heartbeat so the runtime can tell "agent idle" from "gateway dark".
        self.counters = {"evaluated": 0, "refused": 0, "unchecked": 0,
                         "unreadable": 0, "unresolved_spans": 0}
        self._heartbeat_task = None
        if not self.ogr_api_key:
            logger.warning("OGR_API_KEY is not set — every evaluate will fail "
                           "into fail_%s", self.ogr_fail_mode)

    # -- mitmproxy plumbing (inert in the offline tests) --------------------
    def load(self, loader) -> None:  # pragma: no cover - needs mitmproxy
        for name, typ, _env, _default, help_text in _OPTIONS:
            loader.add_option(name, typ, getattr(self, name), help_text)

    def configure(self, updated) -> None:  # pragma: no cover - needs mitmproxy
        for name, _typ, _env, _default, _help in _OPTIONS:
            if name in updated:
                setattr(self, name, getattr(_mitm_ctx.options, name))

    def running(self) -> None:  # pragma: no cover - needs a live event loop
        self._heartbeat_task = asyncio.get_running_loop().create_task(
            self._heartbeat_loop())

    def done(self) -> None:  # pragma: no cover
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()

    # -- identity ------------------------------------------------------------
    def identity(self) -> dict:
        """All four fields, always present; '' is the explicit 'no assertion'
        (never an omission — every integrator answers the identity question).
        A gateway fills these from its own caller authentication/config; a
        forward proxy has no per-caller credential, so they are operator
        config here and the API key is the identity floor beneath them."""
        return {"agent_id": self.ogr_agent_id,
                "agent_type": self.ogr_agent_type,
                "agent_workspace": self.ogr_agent_workspace,
                "agent_user": self.ogr_agent_user}

    # -- the one call ----------------------------------------------------------
    async def _evaluate(self, data: bytes) -> dict | None:
        """POST one event; None on ANY failure (timeout, 429, 5xx, network,
        non-verdict 200) — a 429 is an outage, not an allow. Blocking I/O runs
        in an executor so the proxy event loop never serializes on the PDP."""
        loop = asyncio.get_running_loop()
        try:
            verdict = await loop.run_in_executor(
                None, post_json, self.ogr_url.rstrip("/") + "/v1/evaluate",
                self.ogr_api_key, data, self.ogr_timeout)
        except Exception as exc:  # noqa: BLE001 - every failure maps to the fail mode
            logger.warning("[OGR] evaluate failed: %s", exc)
            verdict = None
        if verdict is not None:
            self.counters["evaluated"] += 1
        return verdict

    async def _heartbeat_loop(self) -> None:  # pragma: no cover - timing loop
        while True:
            await asyncio.sleep(HEARTBEAT_INTERVAL_S)
            body = json.dumps({"integration": INTEGRATION,
                               "interval_s": HEARTBEAT_INTERVAL_S,
                               "counters": self.counters}).encode("utf-8")
            try:
                await asyncio.get_running_loop().run_in_executor(
                    None, post_json, self.ogr_url.rstrip("/") + "/v1/heartbeat",
                    self.ogr_api_key, body, self.ogr_timeout)
            except Exception as exc:  # noqa: BLE001 - liveness must never kill the proxy
                logger.debug("[OGR] heartbeat failed: %s", exc)

    # -- verdict enforcement ---------------------------------------------------
    def _refuse(self, flow, llm_protocol: str, status: int, message: str,
                event_id: str = "") -> None:
        headers = {"x-ogr-decision": "block"}
        if event_id:
            headers["x-ogr-event-id"] = event_id
        flow.response = make_response(status, refusal_body(llm_protocol, message), headers)
        self.counters["refused"] += 1

    def _gate(self, flow, llm_protocol: str, verdict: dict | None) -> bool:
        """True = the step half may proceed. Three refusals, one rule: a block
        is a block; and under fail_mode=closed, 'could not look' — no verdict,
        or a verdict whose `unjudged` names paths — is not 'found nothing'
        (verdict.md § unjudged)."""
        if verdict is None:
            if self.ogr_fail_mode == "closed":
                self._refuse(flow, llm_protocol, 503,
                             "OpenGuardrails: no verdict (fail-closed)")
                return False
            self.counters["unchecked"] += 1  # the number to alert on
            return True
        if verdict.get("decision") == "block":
            findings = verdict.get("findings") or []
            categories = sorted({f.get("category", "") for f in findings} - {""})
            message = "Blocked by OpenGuardrails policy" + (
                ": " + ", ".join(categories) if categories else "")
            logger.info("[OGR] block: %s", message)
            self._refuse(flow, llm_protocol, 403, message,
                         verdict.get("event_id", ""))
            return False
        if verdict.get("unjudged"):
            if self.ogr_fail_mode == "closed":
                # Distinct message from the transport failure: the runtime
                # answered, it just did not answer about everything.
                self._refuse(flow, llm_protocol, 503,
                             "OpenGuardrails: partial verdict (fail-closed): "
                             + ", ".join(map(str, verdict["unjudged"])))
                return False
            self.counters["unchecked"] += 1
        return True

    def _apply_spans(self, verdict: dict | None, body: dict) -> bool:
        """Apply modification spans in place; True if the body changed."""
        spans = ((verdict or {}).get("modifications") or {}).get("spans") or []
        if not spans:
            return False
        self.counters["unresolved_spans"] += apply_spans(body, spans)
        return True

    # -- request hook: PRE-MODEL, judge exactly what is about to be sent ------
    async def request(self, flow) -> None:
        if flow.request.method != "POST":
            return
        llm_protocol = match_protocol(flow.request.path)
        if llm_protocol is None:
            return  # not an LLM call — pass through untouched
        text = flow.request.get_text() or ""
        try:
            body = json.loads(text)
        except ValueError:
            body = None
        if not isinstance(body, dict):
            # Recognized path, unreadable body: it passes UNJUDGED but counted —
            # silence is indistinguishable from health.
            self.counters["unreadable"] += 1
            logger.warning("[OGR] unreadable %s request body — not judged", llm_protocol)
            return

        step_id = uuid.uuid4().hex  # fresh per model call; binds the two halves
        meta = {"step_id": step_id, "llm_protocol": llm_protocol}
        flow.metadata["ogr"] = meta

        verdict = await self._evaluate(event_json(
            "step/request", step_id, self.identity(), llm_protocol, text))
        if not self._gate(flow, llm_protocol, verdict):
            return  # blocked/refused: flow.response is set, the model is never called
        if self._apply_spans(verdict, body):
            # Spans applied BEFORE sending — the redacted body is what leaves.
            flow.request.set_text(json.dumps(body, ensure_ascii=False))
        # started_at is stamped at the request's RELEASE upstream (after the
        # verdict), so TTFT measures the provider, not our evaluate wait.
        meta["started_at"] = now_iso()

    # -- response hook: POST-MODEL, judge before the agent acts ---------------
    async def response(self, flow) -> None:
        meta = flow.metadata.get("ogr")
        if not meta or flow.response is None:
            return  # unrecognized path, or a request we could not judge
        if flow.response.headers.get("x-ogr-decision"):
            return  # our own refusal echoing through the hook — never re-judge it
        if flow.response.status_code != 200:
            return  # an upstream error carries no model answer to judge
        llm_protocol = meta["llm_protocol"]
        timing = {"started_at": meta.get("started_at") or now_iso(),
                  "completed_at": now_iso()}
        # mitmproxy buffered the reply whole; no first-token moment was
        # observed, and a buffered reply omits first_token_at rather than
        # inventing one.
        raw = flow.response.get_text() or ""
        streaming = "text/event-stream" in (flow.response.headers.get("content-type") or "")

        if streaming:
            payload, event_protocol = reassemble_stream(llm_protocol, raw)
            if payload is None:
                self.counters["unreadable"] += 1
                logger.warning("[OGR] unreadable %s stream — not judged", llm_protocol)
                return
            if "timing" not in payload:
                payload["timing"] = timing
            data = event_json("step/response", meta["step_id"], self.identity(),
                              event_protocol,
                              json.dumps(payload, ensure_ascii=False))
        else:
            try:
                body = json.loads(raw)
            except ValueError:
                body = None
            if not isinstance(body, dict):
                self.counters["unreadable"] += 1
                logger.warning("[OGR] unreadable %s response body — not judged", llm_protocol)
                return
            payload_text = raw if "timing" in body else splice_timing(raw, timing)
            data = event_json("step/response", meta["step_id"], self.identity(),
                              llm_protocol, payload_text)

        verdict = await self._evaluate(data)
        if not self._gate(flow, llm_protocol, verdict):
            # The buffered answer — prose, tool calls, the whole stream — is
            # withheld; the agent gets the refusal instead and no tool runs.
            return
        if not streaming and self._apply_spans(verdict, body):
            flow.response.set_text(json.dumps(body, ensure_ascii=False))
        elif streaming:
            # Spans against a reassembled stream name the canonical payload,
            # not the SSE frames we would forward; splicing them is not
            # possible, so they are counted unresolved, never half-applied.
            spans = ((verdict or {}).get("modifications") or {}).get("spans") or []
            if spans:
                self.counters["unresolved_spans"] += len(spans)


addons = [OGRGateway()]
