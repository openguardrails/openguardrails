"""OGRGateway — a mitmproxy addon that binds the LLM wire protocol to the
OpenGuardrails runtime PDP.

    agent --HTTPS--> mitmproxy (this addon) --> LLM API
                         │
                         └── GuardEvent → POST /api/public/ogr/v1/evaluate → Verdict

Every intercepted LLM request/response is normalized into an OGR GuardEvent and
evaluated by the runtime. A `block` / `require_approval` verdict short-circuits
the flow with a protocol-correct error, so a policy-violating run never reaches
the model (request side) or its output never reaches the agent (response side).

Enforcement is at the runtime: configure a policy there (e.g. attach the
`moderation` guardrail). This addon carries no detection logic — it is a pure PEP.

Run:
    OGR_RUNTIME_URL=http://localhost:3000 OGR_API_KEY=ogr_... \
        mitmdump -s ogr_mitmproxy/addon.py

mitmproxy event hooks used (https://docs.mitmproxy.org/stable/api/events.html):
`request` (inbound prompt) and `response` (model completion).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os

from mitmproxy import http

from . import protocols
from .ogr_client import OGRClient, make_event

logger = logging.getLogger("ogr.gateway")

BLOCKING = ("block", "require_approval")


def _truthy(v: str | None, default: bool) -> bool:
    if v is None:
        return default
    return v.strip().lower() not in ("0", "false", "no", "off")


class OGRGateway:
    def __init__(self) -> None:
        self.runtime = os.environ.get("OGR_RUNTIME_URL", "http://localhost:3000")
        self.api_key = os.environ.get("OGR_API_KEY", "")
        self.agent_id = os.environ.get("OGR_AGENT_ID", "mitmproxy-agent")
        self.agent_type = os.environ.get("OGR_AGENT_TYPE", "")
        # fail-closed: if the runtime is unreachable, block rather than pass the call.
        self.fail_closed = _truthy(os.environ.get("OGR_FAIL_MODE_CLOSED"), True)
        # also moderate the model's completion on the way back.
        self.check_response = _truthy(os.environ.get("OGR_CHECK_RESPONSE"), True)
        timeout = float(os.environ.get("OGR_EVAL_TIMEOUT", "2.0"))
        self.client = OGRClient(self.runtime, self.api_key, timeout=timeout)
        if not self.api_key:
            logger.warning("OGR_API_KEY is not set — runtime calls will be rejected (401).")
        logger.info("OGR gateway → %s (fail_%s, check_response=%s)",
                    self.runtime, "closed" if self.fail_closed else "open", self.check_response)

    # ── helpers ───────────────────────────────────────────────────────────
    def _subject(self) -> dict:
        s = {"agent_id": self.agent_id}
        if self.agent_type:
            s["agent_type"] = self.agent_type
        return s

    def _session(self, flow: http.HTTPFlow) -> str:
        h = flow.request.headers
        return (h.get("x-ogr-session") or h.get("x-session-id")
                or f"conn-{flow.client_conn.id}")

    async def _evaluate(self, event: dict) -> dict | None:
        """Call the PDP off the event loop; None on transport/PDP failure."""
        loop = asyncio.get_event_loop()
        try:
            return await loop.run_in_executor(None, self.client.evaluate, event)
        except Exception as exc:  # noqa: BLE001 - map any failure to fail mode
            logger.warning("[OGR] evaluate failed: %s", exc)
            return None

    def _fail_closed_block(self, proto: str) -> http.Response:
        return protocols.block_response(
            proto, "guardrail unavailable (fail-closed)", {"decision": "block"})

    # ── request side: moderate the inbound prompt ─────────────────────────
    async def request(self, flow: http.HTTPFlow) -> None:
        proto = protocols.match(flow.request.path)
        if proto is None:
            return  # not an LLM call — pass through untouched
        try:
            body = json.loads(flow.request.get_text() or "{}")
        except ValueError:
            return
        parsed = protocols.parse_request(proto, body)
        text = parsed.get("latest_user")
        if not text:
            return
        guard_id = protocols.new_guard_id()
        flow.metadata["ogr_guard_id"] = guard_id
        flow.metadata["ogr_proto"] = proto

        event = make_event(
            "user_input", subject=self._subject(), payload={"text": text},
            session_id=self._session(flow), guard_id=guard_id, llm_protocol=proto,
            provenance=[{"source": "user", "trust": "unverified"}])
        verdict = await self._evaluate(event)

        if verdict is None:
            if self.fail_closed:
                flow.response = self._fail_closed_block(proto)
            return
        if verdict.get("decision") in BLOCKING:
            logger.info("[OGR] %s request (%s): %s", verdict["decision"],
                        self._session(flow), protocols.reasons(verdict))
            flow.response = protocols.block_response(proto, protocols.reasons(verdict), verdict)

    # ── response side: moderate the model completion ──────────────────────
    async def response(self, flow: http.HTTPFlow) -> None:
        if not self.check_response:
            return
        proto = flow.metadata.get("ogr_proto") or protocols.match(flow.request.path)
        if proto is None or flow.response is None:
            return
        if flow.response.status_code != 200:
            return  # our own block, or an upstream error — nothing to moderate
        if "event-stream" in flow.response.headers.get("content-type", ""):
            return  # streaming completion — response-side moderation is a follow-up
        try:
            body = json.loads(flow.response.get_text() or "{}")
        except ValueError:
            return
        text = protocols.parse_response(proto, body)
        if not text:
            return

        event = make_event(
            "model_output", subject=self._subject(), payload={"text": text},
            session_id=self._session(flow), guard_id=flow.metadata.get("ogr_guard_id"),
            llm_protocol=proto, provenance=[{"source": "model", "trust": "unverified"}])
        verdict = await self._evaluate(event)

        if verdict is None:
            if self.fail_closed:
                flow.response = self._fail_closed_block(proto)
            return
        if verdict.get("decision") in BLOCKING:
            logger.info("[OGR] %s response (%s): %s", verdict["decision"],
                        self._session(flow), protocols.reasons(verdict))
            flow.response = protocols.block_response(proto, protocols.reasons(verdict), verdict)

    # ── WebSocket side: moderate Codex (ChatGPT backend) request frames ────
    async def websocket_message(self, flow: http.HTTPFlow) -> None:
        """Codex-in-ChatGPT-mode speaks the Responses API over a WebSocket
        (chatgpt.com/backend-api/codex/responses), so its user input never hits
        the request/response hooks. Moderate the client→server `response.create`
        frame; on block, drop the frame and kill the flow so the model never
        sees the unsafe turn."""
        if not protocols.is_codex_ws(flow.request.path):
            return
        msg = flow.websocket.messages[-1]
        if not msg.from_client or not msg.is_text:
            return
        parsed = protocols.parse_codex_ws_user(msg.content.decode("utf-8", "replace"))
        if parsed is None:
            return
        text, turn_id = parsed

        # response.create re-sends history each turn; remember the verdict per turn so
        # we evaluate once but keep DROPPING resends of a blocked turn (never forward it).
        seen = flow.metadata.setdefault("ogr_ws_verdict", {})
        key = turn_id or text
        if key in seen:
            if seen[key] in BLOCKING:
                msg.drop()
            return

        event = make_event(
            "user_input", subject=self._subject(), payload={"text": text},
            session_id=self._session(flow), llm_protocol="openai.responses",
            provenance=[{"source": "user", "trust": "unverified"}])
        verdict = await self._evaluate(event)
        decision = (verdict or {}).get("decision") or ("block" if self.fail_closed else "allow")
        seen[key] = decision

        if decision in BLOCKING:
            logger.info("[OGR] %s codex-ws (%s): %s", decision,
                        self._session(flow), protocols.reasons(verdict or {}))
            msg.drop()          # the unsafe request frame never reaches the model
            flow.kill()         # best-effort socket teardown so codex stops waiting


addons = [OGRGateway()]
