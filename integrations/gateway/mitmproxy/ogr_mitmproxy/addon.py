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

Run (load `run.py`, not this module — see the README):
    OGR_RUNTIME_URL=http://localhost:3000 OGR_API_KEY=ogr_... \
        mitmdump -s run.py

mitmproxy event hooks used (https://docs.mitmproxy.org/stable/api/events.html):
`request` (inbound prompt), `response` (model completion), and
`websocket_message` (Codex over its ChatGPT-backend socket, where the agent's
tool_call / tool_result surfaces live).
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
        # withhold streamed tool-call fragments until the completed call is judged.
        self.hold_tool_deltas = _truthy(os.environ.get("OGR_WS_HOLD_TOOL_DELTAS"), True)
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

    # ── WebSocket side: moderate Codex (ChatGPT backend) traffic ──────────
    async def websocket_message(self, flow: http.HTTPFlow) -> None:
        """Codex-in-ChatGPT-mode speaks the Responses API over a WebSocket
        (chatgpt.com/backend-api/codex/responses), so nothing reaches the
        request/response hooks. Three surfaces ride this socket:

          client→server  `response.create`      → user_input, tool_result
          server→client  `response.output_item.done` (custom_tool_call)
                                                 → tool_call   ← the agent surface

        The tool_call direction is the one that matters for a coding agent:
        that frame is the model telling Codex to run a command, and mitmproxy
        awaits this hook before forwarding it, so a `block` verdict stops the
        command from ever reaching the agent.
        """
        if not protocols.is_codex_ws(flow.request.path):
            return
        msg = flow.websocket.messages[-1]
        if not msg.is_text:
            return
        frame = protocols.codex_frame(msg.content.decode("utf-8", "replace"))
        if frame is None:
            return  # unparseable, or Codex's own auto-reviewer talking
        if msg.from_client:
            await self._ws_from_client(flow, msg, frame)
        else:
            await self._ws_from_server(flow, msg, frame)

    def _ws_state(self, flow: http.HTTPFlow) -> dict:
        """Per-socket conversation state feeding the authz envelope."""
        return flow.metadata.setdefault(
            "ogr_ws", {"transcript": [], "system_prompt": "", "verdicts": {}})

    def _authz(self, flow: http.HTTPFlow) -> dict:
        st = self._ws_state(flow)
        authz: dict = {}
        if st["transcript"]:
            authz["transcript"] = st["transcript"][-protocols.MAX_TRANSCRIPT_ENTRIES:]
        if st["system_prompt"]:
            authz["agent_system_prompt"] = st["system_prompt"]
        return authz

    async def _ws_from_client(self, flow: http.HTTPFlow, msg, frame: dict) -> None:
        st = self._ws_state(flow)
        if not st["system_prompt"]:
            st["system_prompt"] = protocols.parse_codex_ws_system_prompt(frame)

        # Tool results: untrusted content entering the context (indirect injection).
        for out in protocols.parse_codex_ws_tool_outputs(frame):
            event = make_event(
                "tool_result", subject=self._subject(),
                payload={"result": out["text"], "call_id": out["call_id"]},
                session_id=self._session(flow), llm_protocol="openai.responses",
                authz=self._authz(flow),
                provenance=[{"source": "tool", "trust": "untrusted"}])
            verdict = await self._evaluate(event)
            decision = (verdict or {}).get("decision") or (
                "block" if self.fail_closed else "allow")
            if decision in BLOCKING:
                logger.info("[OGR] %s codex-ws tool_result (%s): %s", decision,
                            self._session(flow), protocols.reasons(verdict or {}))
                msg.drop()      # poisoned tool output never reaches the model
                flow.kill()
                return

        parsed = protocols.parse_codex_ws_user(msg.content.decode("utf-8", "replace"))
        if parsed is None:
            return
        text, turn_id = parsed
        st["transcript"].append(protocols.transcript_entry("user", text=text))

        # response.create re-sends the opening turn; remember the verdict per turn so
        # we evaluate once but keep DROPPING resends of a blocked turn.
        seen = st["verdicts"]
        key = f"user:{turn_id or text}"
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
            logger.info("[OGR] %s codex-ws user_input (%s): %s", decision,
                        self._session(flow), protocols.reasons(verdict or {}))
            msg.drop()          # the unsafe request frame never reaches the model
            flow.kill()         # best-effort socket teardown so codex stops waiting

    async def _ws_from_server(self, flow: http.HTTPFlow, msg, frame: dict) -> None:
        # Withhold the incremental tool-call stream: it lands before the completed
        # item we gate on, and Codex can assemble a runnable call from it. The
        # completed `output_item.done` carries the full input, so suppressing the
        # deltas costs the agent nothing but the typing animation.
        if self.hold_tool_deltas and protocols.is_codex_tool_input_delta(frame):
            msg.drop()
            return

        call = protocols.parse_codex_ws_tool_call(frame)
        if call is None:
            return

        event = make_event(
            "tool_call", subject=self._subject(),
            payload={"name": call["name"], "arguments": {"input": call["arguments"]},
                     "call_id": call["call_id"]},
            session_id=self._session(flow), llm_protocol="openai.responses",
            authz=self._authz(flow),
            provenance=[{"source": "model", "trust": "unverified"}])
        verdict = await self._evaluate(event)
        decision = (verdict or {}).get("decision") or ("block" if self.fail_closed else "allow")

        if decision in BLOCKING:
            logger.info("[OGR] %s codex-ws tool_call %s (%s): %s", decision,
                        call["name"], self._session(flow),
                        protocols.reasons(verdict or {}))
            msg.drop()          # the command never reaches the agent
            flow.kill()         # Codex surfaces this as a failed turn (no clean 403 on a socket)
            return

        logger.info("[OGR] allow codex-ws tool_call %s (%s)", call["name"],
                    self._session(flow))
        self._ws_state(flow)["transcript"].append(
            protocols.transcript_entry("assistant", tool_name=call["name"],
                                       tool_input=call["arguments"]))


addons = [OGRGateway()]
