"""An OGR v0.8 LLM gateway in one file — documentation that runs.

    client ──HTTP──▶ this gateway ──▶ provider (OpenAI / Anthropic)
                        │
                        └── GuardEvent → POST {OGR_URL}/v1/evaluate → Verdict

This is the normative gateway recipe (specification/runtime-api.md, "The
recipe") written for reading: stdlib only, no SDK — the Runtime API *is* the
integration surface, and an integration is an API key, nine fields, and one
endpoint. Per proxied model call:

    1. mint step_id                       (one line, no bookkeeping)
    2. evaluate step/request              raw request body, verbatim
         block → answer the caller with a protocol-shaped error; the
                 provider is never called
    3. forward upstream
    4. evaluate step/response             raw response body (+ timing);
                                          a stream is reassembled and judged
                                          ONCE, whole, behind a held tail
         block → the answer is withheld / the stream is cut before its tail
    5. heartbeat every 30s                {integration, counters}

Streaming is the one non-obvious part, and it is the spec's tail-hold
(runtime-api.md § streaming): SSE frames are forwarded as they arrive, but
the final OGR_TAIL_HOLD characters of client-visible content stay held. At
stream end the whole reply is reassembled into the canonical shape and judged
once; `allow` releases the tail, `block` drops it and the stream never
completes — so the terminal frame ([DONE] / message_stop) is never delivered
and no tool call was actionable before the verdict. The accepted cost is that
content ahead of the tail has already been seen; a deployment that cannot
accept it sets OGR_TAIL_HOLD=inf, which degenerates to buffering the whole
reply.

Run:

    export OGR_URL=https://ogr.example.com OGR_API_KEY=ogr_...
    export OGR_AGENT_ID=my-gateway            # the four-tuple, see Config
    python3 gateway.py --port 8800

then point any OpenAI or Anthropic client's base URL at it. This example
authenticates nobody, so the four-tuple comes from env; a real gateway fills
`agent_id` from its own caller authentication (the authenticated caller IS
the agent) — that lookup is the only piece intentionally left out.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
import uuid
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

logger = logging.getLogger("ogr.gateway-example")

# The build id rides ONLY on the heartbeat in v0.8 — it left the GuardEvent.
INTEGRATION = "ogr-gateway-example/1.0.0"
HEARTBEAT_INTERVAL_S = 30

# path → (llm_protocol, which upstream). The producer states the payload
# shape (guard-event.md § llm_protocol); here the route is the statement.
ROUTES = {
    "/v1/chat/completions": ("openai.chat", "upstream_openai"),
    "/v1/messages": ("anthropic.messages", "upstream_anthropic"),
}

# Request headers forwarded upstream. An allowlist, because the client's
# hop-by-hop and host headers are ours, not the provider's.
FORWARD_HEADERS = ("authorization", "x-api-key", "anthropic-version",
                   "anthropic-beta", "openai-organization", "content-type")


@dataclass
class Config:
    """Everything the gateway needs, env-first. The five identity fields are
    all REQUIRED on the wire with '' as the explicit "no assertion" — an
    integrator answers the identity question, never falls into the API-key
    floor by omission (guard-event.md § identity)."""
    ogr_url: str = "http://localhost:3000"
    ogr_api_key: str = ""
    agent_id: str = ""          # WHICH agent ('' = derived from the API key)
    agent_type: str = ""        # what KIND — a label, never an identity
    agent_workspace: str = ""   # agent group = policy set ('' = key's workspace)
    agent_user: str = ""        # who is using it ('' = every session one user)
    fail_mode: str = "open"     # 'closed' refuses when no verdict arrives
    tail: float = 200           # held-back chars of a streamed reply; inf = buffer
    timeout: float = 5.0        # the evaluate budget — a ceiling, not a target
    upstream_openai: str = "https://api.openai.com"
    upstream_anthropic: str = "https://api.anthropic.com"

    @classmethod
    def from_env(cls) -> "Config":
        env = os.environ.get
        return cls(
            ogr_url=env("OGR_URL", cls.ogr_url),
            ogr_api_key=env("OGR_API_KEY", ""),
            agent_id=env("OGR_AGENT_ID", ""),
            agent_type=env("OGR_AGENT_TYPE", ""),
            agent_workspace=env("OGR_AGENT_WORKSPACE", ""),
            agent_user=env("OGR_AGENT_USER", ""),
            fail_mode=env("OGR_FAIL_MODE", "open"),
            tail=float(env("OGR_TAIL_HOLD", "200")),
            timeout=float(env("OGR_TIMEOUT", "5.0")),
            upstream_openai=env("OGR_UPSTREAM_OPENAI", cls.upstream_openai),
            upstream_anthropic=env("OGR_UPSTREAM_ANTHROPIC", cls.upstream_anthropic),
        )

    def identity(self) -> dict:
        return {"agent_id": self.agent_id, "agent_type": self.agent_type,
                "agent_workspace": self.agent_workspace, "agent_user": self.agent_user}


# ── the wire: one endpoint, hand-rolled ─────────────────────────────────────

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def event_json(kind: str, step_id: str, identity: dict, llm_protocol: str,
               payload_text: str) -> bytes:
    """Serialize a GuardEvent AROUND the payload text: the envelope is ours to
    encode, the payload is the provider's body spliced in verbatim. The v0.8
    event is those nine required fields plus `integration`, the one optional
    one — no version, no coordinates, no timestamp; everything a runtime can
    derive left the wire."""
    head = json.dumps({"kind": kind, "step_id": step_id, **identity,
                       "llm_protocol": llm_protocol,
                       # WHO REPORTED IT — the one OPTIONAL v0.8 field, and the SAME
                       # constant the heartbeat sends (two literals would drift and
                       # each would look right alone). Stamped in this ONE builder so
                       # it cannot go missing on one kind of event only.
                       "integration": INTEGRATION}, ensure_ascii=False)
    return (head[:-1] + ', "payload": ' + payload_text + "}").encode("utf-8")


def splice_timing(payload_text: str, timing: dict) -> str:
    """Insert a top-level `timing` key into a RAW body's own bytes — byte
    insertion, never re-serialization, so verdict span offsets keep indexing
    the strings as transported (guard-event.md § usage and timing). The
    caller has checked the body carries no `timing` of its own."""
    i = payload_text.find("{")
    if i < 0:
        return payload_text
    rest = payload_text[i + 1:].lstrip()
    sep = "" if rest.startswith("}") else ", "
    return (payload_text[:i + 1]
            + '"timing": ' + json.dumps(timing) + sep + payload_text[i + 1:])


def post_json(url: str, api_key: str, data: bytes, timeout: float) -> dict | None:
    """One authenticated POST; a dict back, or None. A 200 whose body is not
    an object is a failure, not an allow."""
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {api_key}"})
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 - operator-configured URL
        body = json.loads(r.read() or b"null")
    return body if isinstance(body, dict) else None


def evaluate(cfg: Config, counters: dict, data: bytes) -> dict | None:
    """The whole protocol is this one call. None on ANY failure — timeout,
    429, 5xx, network, a non-verdict 200 — and deciding what None means is
    the fail mode's job (degraded-mode.md: a 429 is an outage, not an
    allow). The unchecked counter is the loud signal the spec requires:
    traffic that passed with no verdict behind it."""
    try:
        verdict = post_json(cfg.ogr_url.rstrip("/") + "/v1/evaluate",
                            cfg.ogr_api_key, data, cfg.timeout)
    except Exception as exc:  # noqa: BLE001 - every failure maps to the fail mode
        logger.warning("evaluate failed: %s", exc)
        verdict = None
    if verdict is not None:
        counters["evaluated"] += 1
    return verdict


# ── redaction: applying the verdict's spans ─────────────────────────────────

def apply_spans(body: dict, spans: list[dict]) -> int:
    """Apply `modifications.spans` in place; return how many did NOT resolve.
    Spans on one string apply highest offset first so a splice cannot shift
    the offsets a later span was computed against; a span that names nothing
    this body holds is dropped and COUNTED, never applied somewhere else."""
    unresolved = 0
    groups: dict[tuple, list[dict]] = {}
    for span in spans:
        norm = str(span.get("path", "")).replace("[", ".").replace("]", "")
        parts = [p for p in norm.split(".") if p]
        if not parts or parts[0] != "payload":
            unresolved += 1
            continue
        groups.setdefault(tuple(parts[1:]), []).append(span)
    for parts, group in groups.items():
        node = body
        for token in parts[:-1]:
            key = int(token) if isinstance(node, list) and token.lstrip("-").isdigit() else token
            node = node.get(key) if isinstance(node, dict) else (
                node[key] if isinstance(node, list) and isinstance(key, int)
                and -len(node) <= key < len(node) else None)
            if node is None:
                break
        leaf = (int(parts[-1]) if isinstance(node, list) and parts and parts[-1].lstrip("-").isdigit()
                else (parts[-1] if parts else None))
        value = (node.get(leaf) if isinstance(node, dict)
                 else node[leaf] if isinstance(node, list) and isinstance(leaf, int)
                 and -len(node) <= leaf < len(node) else None)
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
        node[leaf] = value
    return unresolved


# ── SSE: reading, counting, reassembling ────────────────────────────────────

def sse_events(stream):
    """Yield (raw_event_bytes, parsed_data_or_None) per SSE event, preserving
    the bytes exactly so what we forward is what the provider sent."""
    pending: list[bytes] = []
    data_lines: list[str] = []
    for line in stream:
        pending.append(line)
        text = line.decode("utf-8", "replace").rstrip("\r\n")
        if text.startswith("data:"):
            data_lines.append(text[5:].lstrip())
        elif text == "":
            data = "\n".join(data_lines)
            parsed = None
            if data and data.strip() != "[DONE]":
                try:
                    parsed = json.loads(data)
                except ValueError:
                    parsed = None
            yield b"".join(pending), (parsed if isinstance(parsed, dict) else None)
            pending, data_lines = [], []
    if pending:  # a final event unterminated by a blank line
        yield b"".join(pending), None


def visible_chars(llm_protocol: str, frame: dict | None) -> int:
    """How much CLIENT-VISIBLE content one frame carries — the unit the held
    tail is measured in. Tool-call argument fragments count too: an agent can
    act on an assembled call, so the tail must be able to hold them back."""
    if frame is None:
        return 0
    n = 0
    if llm_protocol == "anthropic.messages":
        delta = frame.get("delta") or {}
        n += len(delta.get("text", "")) + len(delta.get("thinking", ""))
        n += len(delta.get("partial_json", ""))
    else:
        for choice in frame.get("choices") or []:
            delta = choice.get("delta") or {}
            n += len(delta.get("content") or "")
            n += len(delta.get("reasoning_content") or "")
            for tc in delta.get("tool_calls") or []:
                n += len((tc.get("function") or {}).get("arguments") or "")
    return n


class TailHold:
    """Forward SSE events while withholding the last `tail` characters of
    client-visible content. An event is released only once the events still
    held BEHIND it carry at least `tail` characters — so at any moment the
    client is missing the final stretch of the reply, and a terminal frame
    (which carries 0 characters) can never leave before the verdict."""

    def __init__(self, tail: float, emit):
        self.tail = tail
        self.emit = emit
        self.held: deque[tuple[bytes, int]] = deque()
        self.held_chars = 0

    def add(self, raw: bytes, chars: int) -> None:
        self.held.append((raw, chars))
        self.held_chars += chars
        while self.held and self.held_chars - self.held[0][1] >= self.tail:
            raw, chars = self.held.popleft()
            self.held_chars -= chars
            self.emit(raw)

    def release(self) -> None:
        """allow → the reply completes."""
        while self.held:
            self.emit(self.held.popleft()[0])


def _merge_usage(into: dict, new: dict | None) -> None:
    for k, v in (new or {}).items():
        if v:
            into[k] = v  # Anthropic splits usage across two frames; merge halves


def canonical_usage(llm_protocol: str, usage: dict) -> dict:
    """Transcribe the provider's counters into the canonical names — never
    estimate (no tokenizer here), never report zeros the provider never said."""
    if llm_protocol == "anthropic.messages":
        mapping = {"input_tokens": "input_tokens", "output_tokens": "output_tokens",
                   "cache_read_input_tokens": "cache_read_tokens",
                   "cache_creation_input_tokens": "cache_write_tokens"}
    else:
        mapping = {"prompt_tokens": "input_tokens", "completion_tokens": "output_tokens"}
    return {canon: usage[raw] for raw, canon in mapping.items()
            if isinstance(usage.get(raw), int)}


def reassemble(llm_protocol: str, frames: list[dict]) -> dict:
    """One CANONICAL payload from a completed stream (guard-event.md
    § canonical payloads) — used because no single raw body ever existed."""
    text: list[str] = []
    reasoning: list[str] = []
    tools: dict[int, dict] = {}
    model, usage = "", {}
    for frame in frames:
        if llm_protocol == "anthropic.messages":
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
        else:  # openai.chat
            model = frame.get("model") or model
            _merge_usage(usage, frame.get("usage"))
            for choice in frame.get("choices") or []:
                if choice.get("index", 0) != 0:
                    continue
                delta = choice.get("delta") or {}
                if delta.get("content"):
                    text.append(delta["content"])
                if delta.get("reasoning_content"):
                    reasoning.append(delta["reasoning_content"])
                for tc in delta.get("tool_calls") or []:
                    slot = tools.setdefault(tc.get("index", 0),
                                            {"id": "", "name": "", "arguments": ""})
                    slot["id"] = tc.get("id") or slot["id"]
                    fn = tc.get("function") or {}
                    slot["name"] = fn.get("name") or slot["name"]
                    slot["arguments"] += fn.get("arguments") or ""

    payload: dict = {"text": "".join(text)}
    if reasoning:
        payload["reasoning"] = "".join(reasoning)
    if tools:
        calls = []
        for i in sorted(tools):
            args = tools[i]["arguments"]
            try:  # canonical arguments are an object when they parse
                parsed = json.loads(args or "{}")
            except ValueError:
                parsed = args
            calls.append({"id": tools[i]["id"], "name": tools[i]["name"],
                          "arguments": parsed if isinstance(parsed, (dict, list)) else args})
        payload["tool_calls"] = calls
    if model:
        payload["model"] = model
    counters = canonical_usage(llm_protocol, usage)
    if counters:
        payload["usage"] = counters
    return payload


# ── the gateway ─────────────────────────────────────────────────────────────

def refusal_body(llm_protocol: str, message: str) -> dict:
    """A refusal in the CALLER's protocol."""
    if llm_protocol == "anthropic.messages":
        return {"type": "error", "error": {"type": "forbidden", "message": message}}
    return {"error": {"type": "ogr_policy_block", "code": "guardrails_blocked",
                      "message": message}}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # close-delimited streams; no chunking needed

    @property
    def cfg(self) -> Config:
        return self.server.cfg

    @property
    def counters(self) -> dict:
        return self.server.counters

    def log_message(self, fmt, *args):
        logger.info("%s " + fmt, self.address_string(), *args)

    # -- plumbing -----------------------------------------------------------
    def _send_json(self, status: int, body: dict, headers: dict | None = None) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _refuse(self, status: int, llm_protocol: str, message: str,
                event_id: str = "") -> None:
        self.counters["refused"] += 1
        headers = {"x-ogr-decision": "block"}
        if event_id:
            headers["x-ogr-event-id"] = event_id
        self._send_json(status, refusal_body(llm_protocol, message), headers)

    def _gate(self, verdict: dict | None, llm_protocol: str) -> bool:
        """True = this step half may proceed; False = a refusal was sent.
        Under fail_mode=closed, "could not look" — no verdict, or a verdict
        whose `unjudged` names paths — is not "found nothing" (verdict.md)."""
        if verdict is None:
            if self.cfg.fail_mode == "closed":
                self._refuse(503, llm_protocol, "OpenGuardrails: no verdict (fail-closed)")
                return False
            self.counters["unchecked"] += 1  # loud, per the degraded-mode spec
            return True
        if verdict.get("decision") == "block":
            categories = sorted({f.get("category", "")
                                 for f in verdict.get("findings") or []} - {""})
            self._refuse(403, llm_protocol, "Blocked by OpenGuardrails policy"
                         + (": " + ", ".join(categories) if categories else ""),
                         verdict.get("event_id", ""))
            return False
        if verdict.get("unjudged"):
            if self.cfg.fail_mode == "closed":
                self._refuse(503, llm_protocol,
                             "OpenGuardrails: partial verdict (fail-closed)")
                return False
            self.counters["unchecked"] += 1
        return True

    def _spans(self, verdict: dict | None, body: dict) -> bool:
        spans = ((verdict or {}).get("modifications") or {}).get("spans") or []
        if not spans:
            return False
        self.counters["unresolved_spans"] += apply_spans(body, spans)
        return True

    # -- the recipe, top to bottom -------------------------------------------
    def do_POST(self):
        route = ROUTES.get(self.path.split("?", 1)[0])
        if route is None:
            return self._send_json(404, {"error": {"type": "not_found",
                                                   "message": f"no route for {self.path}"}})
        llm_protocol, upstream_attr = route
        raw = self.rfile.read(int(self.headers.get("content-length", 0) or 0))
        text = raw.decode("utf-8", "replace")
        try:
            body = json.loads(text)
        except ValueError:
            body = None
        if not isinstance(body, dict):
            return self._send_json(400, {"error": {"type": "bad_request",
                                                   "message": "invalid JSON body"}})

        # 1. mint step_id — the ONE coordinate v0.8 kept, because concurrency
        #    makes pairing a call's two halves underivable at the runtime.
        step_id = uuid.uuid4().hex

        # 2. PRE-MODEL: judge exactly what is about to be sent — the raw body.
        verdict = evaluate(self.cfg, self.counters, event_json(
            "step/request", step_id, self.cfg.identity(), llm_protocol, text))
        if not self._gate(verdict, llm_protocol):
            return  # blocked: the provider is never called
        if self._spans(verdict, body):
            # redaction spans applied in place BEFORE sending
            text = json.dumps(body, ensure_ascii=False)

        # 3. forward upstream. started_at is stamped at the RELEASE (after
        #    the input verdict) so TTFT measures the provider, not our wait.
        started_at = now_iso()
        upstream = getattr(self.cfg, upstream_attr).rstrip("/") + self.path
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() in FORWARD_HEADERS}
        request = urllib.request.Request(upstream, data=text.encode("utf-8"),
                                         method="POST", headers=headers)
        try:
            response = urllib.request.urlopen(request, timeout=300)  # noqa: S310
        except urllib.error.HTTPError as err:
            response = err  # provider errors relay verbatim below
        except OSError as exc:
            return self._send_json(502, {"error": {"type": "upstream_unreachable",
                                                   "message": str(exc)}})

        with response:
            content_type = response.headers.get("content-type", "")
            if response.status != 200:
                # an upstream error carries no model answer to judge
                data = response.read()
                self.send_response(response.status)
                self.send_header("content-type", content_type or "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            if "text/event-stream" in content_type:
                return self._stream(response, llm_protocol, step_id,
                                    started_at, content_type)
            return self._buffered(response, llm_protocol, step_id,
                                  started_at, content_type)

    # -- 4a. POST-MODEL, buffered ---------------------------------------------
    def _buffered(self, response, llm_protocol: str, step_id: str,
                  started_at: str, content_type: str) -> None:
        raw = response.read().decode("utf-8", "replace")
        try:
            body = json.loads(raw)
        except ValueError:
            body = None
        if not isinstance(body, dict):
            # recognized route, unreadable reply: relay it unjudged but COUNTED
            self.counters["unreadable"] += 1
            data = raw.encode("utf-8")
            self.send_response(200)
            self.send_header("content-type", content_type)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        # timing rides the raw body as a byte-spliced top-level key; a
        # buffered reply omits first_token_at (buffering is what hides it).
        timing = {"started_at": started_at, "completed_at": now_iso()}
        payload_text = raw if "timing" in body else splice_timing(raw, timing)
        verdict = evaluate(self.cfg, self.counters, event_json(
            "step/response", step_id, self.cfg.identity(), llm_protocol, payload_text))
        if not self._gate(verdict, llm_protocol):
            return  # the model's answer — prose AND tool calls — is withheld
        if self._spans(verdict, body):
            raw = json.dumps(body, ensure_ascii=False)
        data = raw.encode("utf-8")
        self.send_response(200)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # -- 4b. POST-MODEL, streamed: hold the tail, judge once -------------------
    def _stream(self, response, llm_protocol: str, step_id: str,
                started_at: str, content_type: str) -> None:
        self.send_response(200)
        self.send_header("content-type", content_type)
        self.send_header("connection", "close")  # HTTP/1.0: the close ends the stream
        self.end_headers()

        hold = TailHold(self.cfg.tail, self.wfile.write)
        frames: list[dict] = []
        first_token_at = ""
        for raw_event, frame in sse_events(response):
            if not first_token_at:
                first_token_at = now_iso()
            if frame is not None:
                frames.append(frame)
            # Forward through the hold: everything except the last `tail`
            # characters of content flows to the client immediately.
            hold.add(raw_event, visible_chars(llm_protocol, frame))

        # End of stream: reassemble the WHOLE reply and judge it exactly once
        # (v0.7's per-chunk interim evaluates are gone). Canonical shape,
        # because no single raw body ever existed.
        payload = reassemble(llm_protocol, frames)
        payload["timing"] = {"started_at": started_at,
                             "first_token_at": first_token_at or started_at,
                             "completed_at": now_iso()}
        verdict = evaluate(self.cfg, self.counters, event_json(
            "step/response", step_id, self.cfg.identity(), "canonical",
            json.dumps(payload, ensure_ascii=False)))

        blocked = (verdict or {}).get("decision") == "block" or (
            verdict is None and self.cfg.fail_mode == "closed") or (
            bool((verdict or {}).get("unjudged")) and self.cfg.fail_mode == "closed")
        if blocked:
            # Abort: drop the tail and close. The terminal frame was still in
            # the hold (it carries 0 visible characters, so it can never have
            # left early), so the stream never completes and no tool call was
            # deliverable. There is no 403 to send — the 200 is long gone;
            # cutting the stream IS the refusal (runtime-api.md § streaming).
            self.counters["refused"] += 1
            self.counters["stream_stopped"] += 1
            logger.info("blocked streamed %s reply — tail dropped, stream cut",
                        llm_protocol)
            return
        if verdict is None or verdict.get("unjudged"):
            self.counters["unchecked"] += 1
        spans = ((verdict or {}).get("modifications") or {}).get("spans") or []
        if spans:
            # Spans name the canonical payload; the frames carrying that text
            # are already gone. Counted unresolved, never half-applied.
            self.counters["unresolved_spans"] += len(spans)
        hold.release()  # allow → the caller gets the tail and the terminal frame


# ── serving ────────────────────────────────────────────────────────────────

def make_server(cfg: Config, host: str = "127.0.0.1", port: int = 8800) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), Handler)
    server.cfg = cfg
    server.counters = {"evaluated": 0, "refused": 0, "unchecked": 0,
                       "unreadable": 0, "unresolved_spans": 0, "stream_stopped": 0}
    return server


def heartbeat_forever(cfg: Config, counters: dict) -> None:  # pragma: no cover - timing loop
    """Silencing a PEP is the cheapest bypass; the heartbeat is what makes a
    dark gateway visible. This is also where the integration build id lives
    in v0.8 — it left the event."""
    while True:
        time.sleep(HEARTBEAT_INTERVAL_S)
        try:
            post_json(cfg.ogr_url.rstrip("/") + "/v1/heartbeat", cfg.ogr_api_key,
                      json.dumps({"integration": INTEGRATION,
                                  "interval_s": HEARTBEAT_INTERVAL_S,
                                  "counters": counters}).encode("utf-8"),
                      cfg.timeout)
        except Exception as exc:  # noqa: BLE001 - liveness must never kill the gateway
            logger.debug("heartbeat failed: %s", exc)


def main(argv: list[str] | None = None) -> None:  # pragma: no cover - wiring
    logging.basicConfig(level=logging.INFO, format="%(name)s %(message)s")
    parser = argparse.ArgumentParser(
        prog="gateway.py", description="OpenGuardrails v0.8 example gateway")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8800)
    args = parser.parse_args(argv)
    cfg = Config.from_env()
    if not cfg.ogr_api_key:
        logger.warning("OGR_API_KEY is not set — every evaluate will fail into "
                       "fail_%s", cfg.fail_mode)
    server = make_server(cfg, args.host, args.port)
    threading.Thread(target=heartbeat_forever, args=(cfg, server.counters),
                     daemon=True).start()
    logger.info("listening on http://%s:%s  routes=%s  fail_%s  tail=%s",
                args.host, args.port, list(ROUTES), cfg.fail_mode, cfg.tail)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
