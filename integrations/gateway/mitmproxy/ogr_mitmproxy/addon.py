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

Not every Codex-backend client speaks WebSocket: third-party agents built on
the openai SDK (e.g. hermes-agent) hit the same chatgpt.com/backend-api/codex
URL with a plain HTTPS POST (`stream=true` SSE or a buffered JSON response).
`request`/`response` special-case that path too — see `_codex_http_request`
/ `_codex_http_response` and `protocols.is_codex_http`.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from collections import OrderedDict

from mitmproxy import http

from . import protocols
from .ogr_client import OGRClient, make_event, new_id

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
        # Agent identity is the RUNTIME's job: it recognises the agent from the
        # system prompt's self-definition at ingest. OGR_AGENT_ID/OGR_AGENT_TYPE
        # remain as explicit operator overrides only — no default.
        self.agent_id = os.environ.get("OGR_AGENT_ID", "")
        self.agent_type = os.environ.get("OGR_AGENT_TYPE", "")
        # fail-closed: if the runtime is unreachable, block rather than pass the call.
        self.fail_closed = _truthy(os.environ.get("OGR_FAIL_MODE_CLOSED"), True)
        # also moderate the model's completion on the way back.
        self.check_response = _truthy(os.environ.get("OGR_CHECK_RESPONSE"), True)
        # Uninstrumented agents (Hermes and friends) send ordinary provider
        # requests; lifecycle reconstruction is a server-side gateway
        # responsibility and applies whenever the client sends no x-ogr-*
        # lifecycle headers. Optional x-ogr-* hints always win.
        self.infer_lifecycle = _truthy(os.environ.get("OGR_INFER_LIFECYCLE"), True)
        self._hermes_states: OrderedDict[str, dict] = OrderedDict()
        # withhold streamed tool-call fragments until the completed call is judged.
        self.hold_tool_deltas = _truthy(os.environ.get("OGR_WS_HOLD_TOOL_DELTAS"), True)
        # on a blocked Codex tool_call, rewrite it to a harmless notice (graceful)
        # rather than dropping the frame and killing the socket (silent stall).
        self.ws_block_rewrite = _truthy(os.environ.get("OGR_WS_BLOCK_REWRITE"), True)
        # DEMO: when a block comes from the `moderation` guardrail, hand its
        # refusal text back AS THE MODEL'S REPLY (代答, HTTP 200) instead of an
        # API error. Other blocks (command danger, injection, tool gates) still
        # return a typed 403/409. See protocols.moderation_answer.
        self.answer_on_moderation = _truthy(
            os.environ.get("OGR_ANSWER_ON_MODERATION"), False)
        # DEMO (broader): hand EVERY block back to the agent as a 200 reply
        # carrying the block reason (not just moderation) — a coding agent gets
        # "I can't do that because …" instead of a non-retryable 403 that aborts
        # it. Moderation blocks still use the nicer suggest_answer text.
        self.answer_on_block = _truthy(
            os.environ.get("OGR_ANSWER_ON_BLOCK"), False)
        timeout = float(os.environ.get("OGR_EVAL_TIMEOUT", "2.0"))
        self.client = OGRClient(self.runtime, self.api_key, timeout=timeout)
        # HTTP-transport Codex clients (protocols.is_codex_http) resend full
        # turn history every request (they set `store: false`, so there is no
        # server-side previous_response_id to thread on) — this dedups
        # tool_result judging across those repeats. Keyed by session id since,
        # unlike the WebSocket path, each turn is its own HTTP connection and
        # flow.metadata doesn't survive between them. Capped so a long-lived
        # mitmdump process doesn't accumulate sessions forever.
        self._codex_http_seen_results: OrderedDict[str, set] = OrderedDict()
        # Native agent integrations (Hermes first) provide authoritative Run
        # and Turn headers. Keep just enough bounded state to emit the Run's
        # user_input once and to avoid re-emitting historical tool results
        # included in later model requests.
        self._run_verdicts: OrderedDict[str, dict | None] = OrderedDict()
        self._run_seen_results: OrderedDict[str, set] = OrderedDict()
        self._run_call_guards: OrderedDict[str, dict[str, str]] = OrderedDict()
        if not self.api_key:
            logger.warning("OGR_API_KEY is not set — runtime calls will be rejected (401).")
        logger.info("OGR gateway → %s (fail_%s, check_response=%s, infer_lifecycle=%s)",
                    self.runtime, "closed" if self.fail_closed else "open",
                    self.check_response, self.infer_lifecycle)

    # ── helpers ───────────────────────────────────────────────────────────
    def _subject(self) -> dict:
        s: dict = {}
        if self.agent_id:
            s["agent_id"] = self.agent_id
        if self.agent_type:
            s["agent_type"] = self.agent_type
        return s

    def _session(self, flow: http.HTTPFlow) -> str:
        h = flow.request.headers
        return (h.get("x-ogr-session") or h.get("x-session-id")
                or f"conn-{flow.client_conn.id}")

    def _lifecycle(self, flow: http.HTTPFlow) -> dict | None:
        h = flow.request.headers
        run_id = h.get("x-ogr-run")
        if not run_id:
            return None
        try:
            turn = max(int(h.get("x-ogr-turn") or 0), 0)
        except ValueError:
            turn = 0
        return {"run_id": run_id, "turn": turn}

    @staticmethod
    def _bounded(cache: OrderedDict, key: str, factory):
        if key in cache:
            cache.move_to_end(key)
            return cache[key]
        if len(cache) >= 512:
            cache.popitem(last=False)
        value = factory()
        cache[key] = value
        return value

    def _infer_hermes_lifecycle(
        self, proto: str, body: dict, instruction: str, session_hint: str = "",
        signature: str = "",
    ) -> tuple[str, dict] | None:
        """Best-effort lifecycle for an uninstrumented Hermes main loop.

        Repeated requests carrying the same latest user instruction are model
        Turns of one Run. A response without tool calls completes that Run.
        Conversation history identifies the Session; `/new` resets the first
        user message and therefore starts another inferred Session.
        """
        if not self.infer_lifecycle or not instruction:
            return None
        users = protocols.user_messages(proto, body)
        if not users:
            return None
        first_user = users[0]
        session_id = session_hint
        state = self._hermes_states.get(session_id) if session_id else None
        if not session_id:
            # Without an explicit ordinary provider field, match the growing
            # conversation by its first user message. This also detects /new.
            # A conversation whose history is SHORTER than what a candidate has
            # already seen is a fresh conversation that merely reused the same
            # opening prompt — do not merge it into the older Session.
            for candidate_id, candidate in reversed(self._hermes_states.items()):
                if (candidate.get("inferred")
                        and candidate.get("first_user") == first_user
                        and len(users) >= candidate.get("user_count", 1)):
                    session_id, state = candidate_id, candidate
                    break
        if state is None:
            session_id = session_id or new_id("hermes-session")
            state = self._bounded(
                self._hermes_states,
                session_id,
                lambda: {
                    "session_id": session_id,
                    "first_user": first_user,
                    "inferred": not bool(session_hint),
                    "user_count": len(users),
                    "run_id": "",
                    "instruction": "",
                    "next_turn": 0,
                    "completed": True,
                    "last_signature": "",
                    "last_turn": 0,
                },
            )
        else:
            state["user_count"] = max(state.get("user_count", 1), len(users))
            self._hermes_states.move_to_end(session_id)

        # A resent identical request is the agent retrying a failed provider
        # call (429/403/5xx), not the next roundtrip: reuse the same Turn.
        if signature and signature == state.get("last_signature"):
            return state["session_id"], {
                "run_id": state["run_id"],
                "turn": state["last_turn"],
            }

        if state["completed"] or state["instruction"] != instruction:
            state["run_id"] = new_id("hermes-run")
            state["instruction"] = instruction
            state["next_turn"] = 1
            state["completed"] = False
            turn = 0
        else:
            turn = state["next_turn"]
            state["next_turn"] += 1
        state["last_signature"] = signature
        state["last_turn"] = turn
        return state["session_id"], {"run_id": state["run_id"], "turn": turn}

    def _complete_inferred_hermes_run(self, run_id: str) -> None:
        for state in reversed(self._hermes_states.values()):
            if state.get("run_id") == run_id:
                state["completed"] = True
                return

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

    def _deny(self, proto: str, verdict: dict, streaming: bool = False) -> http.Response:
        """The response for a blocking verdict. When an answer mode is on the
        block is handed back to the agent AS A 200 REPLY carrying a reason
        (graceful degradation) instead of a typed 403/409:
          - a moderation hit uses the nicer `suggest_answer` refusal text;
          - `answer_on_block` covers every other block (injection, command
            danger, a tenant rule, a tool gate) with a templated reason.
        Otherwise the typed block error is returned unchanged."""
        answer = None
        if self.answer_on_moderation or self.answer_on_block:
            answer = protocols.moderation_answer(verdict)
        if answer is None and self.answer_on_block:
            answer = protocols.block_answer_text(verdict)
        if answer is not None:
            return protocols.answer_response(proto, answer, verdict, streaming)
        return protocols.block_response(proto, protocols.reasons(verdict), verdict)

    # ── request side: moderate the inbound prompt ─────────────────────────
    async def request(self, flow: http.HTTPFlow) -> None:
        # A WS handshake for the same URL is a GET; only a POST is an actual
        # Responses API call from an HTTP-transport Codex client.
        if flow.request.method == "POST" and protocols.is_codex_http(flow.request.path):
            await self._codex_http_request(flow)
            return
        proto = protocols.match(flow.request.path)
        if proto is None:
            return  # not an LLM call — pass through untouched
        try:
            body = json.loads(flow.request.get_text() or "{}")
        except ValueError:
            return
        parsed = protocols.parse_request(proto, body)
        text = parsed.get("latest_user")
        request_session_id = protocols.session_id_from_request(
            flow.request.headers, body)
        session_id = request_session_id or self._session(flow)
        lifecycle = self._lifecycle(flow)
        if (lifecycle is None and self.infer_lifecycle
                and protocols.is_transcript_helper_request(proto, body)):
            flow.metadata["ogr_skip"] = True
            return
        if lifecycle is None:
            inferred = self._infer_hermes_lifecycle(
                proto, body, text or "", request_session_id,
                protocols.request_signature(proto, body))
            if inferred is not None:
                session_id, lifecycle = inferred
                flow.metadata["ogr_hermes_inferred"] = True
        flow.metadata["ogr_proto"] = proto
        flow.metadata["ogr_session"] = session_id
        flow.metadata["ogr_lifecycle"] = lifecycle
        if lifecycle is not None:
            await self._request_with_lifecycle(
                flow, proto, body, text or "", session_id, lifecycle)
            return
        if not text:
            return
        guard_id = protocols.new_guard_id()
        flow.metadata["ogr_guard_id"] = guard_id

        event = make_event(
            "user_input", subject=self._subject(), payload={"text": text},
            session_id=session_id, guard_id=guard_id, llm_protocol=proto,
            provenance=[{"source": "user", "trust": "unverified"}])
        verdict = await self._evaluate(event)

        if verdict is None:
            if self.fail_closed:
                flow.response = self._fail_closed_block(proto)
            return
        if verdict.get("decision") in BLOCKING:
            logger.info("[OGR] %s request (%s): %s", verdict["decision"],
                        self._session(flow), protocols.reasons(verdict))
            flow.response = self._deny(proto, verdict, protocols.wants_stream(body))

    async def _request_with_lifecycle(
        self, flow: http.HTTPFlow, proto: str, body: dict, text: str,
        session_id: str, lifecycle: dict,
    ) -> None:
        run_id, turn = lifecycle["run_id"], lifecycle["turn"]
        run_key = f"{session_id}:{run_id}"

        # Tool results ride in the NEXT model request, but semantically they
        # belong to the Turn of the Action that produced them (the tool_call we
        # emitted from the previous response). Full-history protocols repeat
        # them, so correlate by call id/content and emit once.
        seen_results = self._bounded(self._run_seen_results, run_key, set)
        call_guards = self._bounded(self._run_call_guards, run_key, dict)
        for result in protocols.request_tool_results(proto, body):
            identity = result.get("call_id") or json.dumps(
                result, sort_keys=True, ensure_ascii=False, default=str)
            if identity in seen_results:
                continue
            seen_results.add(identity)
            entry = call_guards.get(identity)
            if entry is None:
                # Result for a call we never observed (e.g. gateway restarted
                # mid-run): it answers an Action of the previous roundtrip.
                entry = {"guard": protocols.new_guard_id(),
                         "turn": max(turn - 1, 0)}
                call_guards[identity] = entry
            event = make_event(
                "tool_result", subject=self._subject(), payload=result,
                session_id=session_id, llm_protocol=proto,
                guard_id=entry["guard"],
                run_id=run_id, turn=entry["turn"],
                provenance=[{"source": "tool", "trust": "untrusted"}])
            verdict = await self._evaluate(event)
            if verdict is None:
                # PDP unreachable. Fail-closed blocks; fail-open must keep
                # OBSERVING — an early return here silently drops the rest of
                # this request's telemetry (model_input and its model_output).
                if self.fail_closed:
                    flow.response = self._fail_closed_block(proto)
                    return
                continue
            if verdict.get("decision") in BLOCKING:
                flow.response = self._deny(
                    proto, verdict, protocols.wants_stream(body))
                return

        # One Run has one external user instruction. Subsequent model requests
        # in that Run are model_input Turns, not new user instructions/Runs.
        if run_key in self._run_verdicts:
            self._run_verdicts.move_to_end(run_key)
            user_verdict = self._run_verdicts[run_key]
        elif text:
            user_event = make_event(
                "user_input", subject=self._subject(), payload={"text": text},
                session_id=session_id, llm_protocol=proto,
                run_id=run_id, turn=turn,
                provenance=[{"source": "user", "trust": "unverified"}])
            user_verdict = await self._evaluate(user_event)
            self._bounded(self._run_verdicts, run_key, lambda: user_verdict)
        else:
            user_verdict = {"decision": "allow"}

        if user_verdict is None:
            if self.fail_closed:
                flow.response = self._fail_closed_block(proto)
                return
        elif user_verdict.get("decision") in BLOCKING:
            flow.response = self._deny(
                proto, user_verdict, protocols.wants_stream(body))
            return

        model_event = make_event(
            "model_input", subject=self._subject(),
            payload=protocols.model_input_payload(proto, body),
            session_id=session_id, llm_protocol=proto,
            run_id=run_id, turn=turn,
            provenance=[{"source": "system", "trust": "trusted"},
                        {"source": "user", "trust": "unverified"}])
        verdict = await self._evaluate(model_event)
        if verdict is None:
            if self.fail_closed:
                flow.response = self._fail_closed_block(proto)
            return
        if verdict.get("decision") in BLOCKING:
            flow.response = self._deny(proto, verdict, protocols.wants_stream(body))

    def _is_own_response(self, flow: http.HTTPFlow) -> bool:
        """True if WE generated flow.response (a block error or a 代答 answer).

        When the request hook short-circuits with our own response, mitmproxy
        skips the upstream round-trip but STILL fires the response hook on that
        synthetic response — so without this guard we would re-moderate our own
        block/answer text (e.g. Presidio flags the appeal URL in a 代答 as PII
        and turns a 200 answer into a 403). Every response we mint carries the
        `x-ogr-decision` header; a real upstream response never does.
        """
        return (flow.response is not None
                and flow.response.headers.get("x-ogr-decision") is not None)

    # ── response side: moderate the model completion ──────────────────────
    async def response(self, flow: http.HTTPFlow) -> None:
        if flow.metadata.get("ogr_skip") or self._is_own_response(flow):
            return
        # tool_call gating runs regardless of check_response (it's the yolo
        # judge, not completion moderation) so this dispatch sits ahead of
        # that flag's early-return below.
        if flow.request.method == "POST" and protocols.is_codex_http(flow.request.path):
            await self._codex_http_response(flow)
            return
        proto = flow.metadata.get("ogr_proto") or protocols.match(flow.request.path)
        if proto is None or flow.response is None:
            return
        if flow.response.status_code != 200:
            return  # our own block, or an upstream error — nothing to moderate
        streaming = "event-stream" in flow.response.headers.get("content-type", "")
        raw = flow.response.get_text() or ""
        if streaming:
            body = protocols.parse_sse_response(proto, raw)
        else:
            try:
                body = json.loads(raw or "{}")
            except ValueError:
                return
        lifecycle = flow.metadata.get("ogr_lifecycle") or self._lifecycle(flow)
        if lifecycle is not None:
            await self._response_with_lifecycle(
                flow, proto, body,
                flow.metadata.get("ogr_session") or self._session(flow),
                lifecycle, streaming)
            if (flow.metadata.get("ogr_hermes_inferred")
                    and not protocols.tool_calls_from_response(proto, body)):
                self._complete_inferred_hermes_run(lifecycle["run_id"])
            return
        if not self.check_response or streaming:
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
            flow.response = self._deny(proto, verdict)

    async def _response_with_lifecycle(
        self, flow: http.HTTPFlow, proto: str, body: dict,
        session_id: str, lifecycle: dict, streaming: bool = False,
    ) -> None:
        run_id, turn = lifecycle["run_id"], lifecycle["turn"]
        run_key = f"{session_id}:{run_id}"
        call_guards = self._bounded(self._run_call_guards, run_key, dict)

        # The model's requested operations are the Action leaves of this Turn.
        # Gate them even when completion-text moderation is disabled.
        for call in protocols.tool_calls_from_response(proto, body):
            identity = call.get("call_id") or json.dumps(
                call, sort_keys=True, ensure_ascii=False, default=str)
            # Remember this Action's Turn: its tool_result arrives in the next
            # request but must be attributed back to THIS turn.
            entry = call_guards.setdefault(
                identity, {"guard": protocols.new_guard_id(), "turn": turn})
            event = make_event(
                "tool_call", subject=self._subject(), payload=call,
                session_id=session_id, llm_protocol=proto,
                guard_id=entry["guard"],
                run_id=run_id, turn=turn,
                provenance=[{"source": "model", "trust": "unverified"}])
            verdict = await self._evaluate(event)
            if verdict is None:
                # Fail-open keeps observing the remaining Actions (see the
                # request-side tool_result loop).
                if self.fail_closed:
                    flow.response = self._fail_closed_block(proto)
                    return
                continue
            if verdict.get("decision") in BLOCKING:
                flow.response = self._deny(proto, verdict, streaming)
                return

        if not self.check_response:
            return
        payload = protocols.response_payload(proto, body)
        if not payload:
            return
        event = make_event(
            "model_output", subject=self._subject(), payload=payload,
            session_id=session_id, llm_protocol=proto,
            run_id=run_id, turn=turn,
            provenance=[{"source": "model", "trust": "unverified"}])
        verdict = await self._evaluate(event)
        if verdict is None:
            if self.fail_closed:
                flow.response = self._fail_closed_block(proto)
            return
        if verdict.get("decision") in BLOCKING:
            flow.response = self._deny(proto, verdict, streaming)

    # ── HTTP-transport Codex side: moderate hermes-agent-style clients ─────
    # These callers drive chatgpt.com/backend-api/codex/responses through the
    # openai SDK (plain HTTPS POST) instead of codex-cli's WebSocket protocol,
    # but the underlying Responses API objects are identical — so tool_call
    # extraction reuses the exact same parsers as the WebSocket path.
    def _codex_http_seen(self, session_id: str) -> set:
        cache = self._codex_http_seen_results
        if session_id in cache:
            cache.move_to_end(session_id)
            return cache[session_id]
        if len(cache) >= 256:
            cache.popitem(last=False)
        seen: set = set()
        cache[session_id] = seen
        return seen

    def _codex_http_session_id(self, flow: http.HTTPFlow, session_hint: str | None) -> str:
        h = flow.request.headers
        return (h.get("x-ogr-session") or h.get("x-session-id") or session_hint
                or f"conn-{flow.client_conn.id}")

    async def _codex_http_request(self, flow: http.HTTPFlow) -> None:
        try:
            body = json.loads(flow.request.get_text() or "{}")
        except ValueError:
            return
        if not isinstance(body, dict):
            return
        if protocols.normalize_codex_http_ids(body):
            flow.request.set_text(json.dumps(body))
        parsed = protocols.parse_codex_http_input(body)
        session_id = self._codex_http_session_id(flow, parsed["session_hint"])
        flow.metadata["ogr_codex_http_session"] = session_id
        authz: dict = {}
        if parsed["transcript"]:
            authz["transcript"] = parsed["transcript"]
        if parsed["system_prompt"]:
            authz["agent_system_prompt"] = parsed["system_prompt"]
        flow.metadata["ogr_codex_http_authz"] = authz

        # tool_result: untrusted content re-entering the context. `input[]`
        # repeats every prior turn's items (store=false, no previous_response_id
        # threading), so dedup against what this session already judged.
        seen = self._codex_http_seen(session_id)
        for out in parsed["tool_outputs"]:
            if not out["call_id"] or out["call_id"] in seen:
                continue
            seen.add(out["call_id"])
            event = make_event(
                "tool_result", subject=self._subject(),
                payload={"result": out["text"], "call_id": out["call_id"]},
                session_id=session_id, llm_protocol="openai.responses",
                authz=authz, provenance=[{"source": "tool", "trust": "untrusted"}])
            verdict = await self._evaluate(event)
            decision = (verdict or {}).get("decision") or ("block" if self.fail_closed else "allow")
            if decision in BLOCKING:
                logger.info("[OGR] %s codex-http tool_result (%s): %s", decision,
                            session_id, protocols.reasons(verdict or {}))
                flow.response = self._deny(
                    "openai.responses", verdict or {"decision": decision},
                    protocols.wants_stream(body))
                return

        if not parsed["latest_user"]:
            return
        guard_id = protocols.new_guard_id()
        flow.metadata["ogr_guard_id"] = guard_id
        event = make_event(
            "user_input", subject=self._subject(), payload={"text": parsed["latest_user"]},
            session_id=session_id, guard_id=guard_id, llm_protocol="openai.responses",
            provenance=[{"source": "user", "trust": "unverified"}])
        verdict = await self._evaluate(event)

        if verdict is None:
            if self.fail_closed:
                flow.response = self._fail_closed_block("openai.responses")
            return
        if verdict.get("decision") in BLOCKING:
            logger.info("[OGR] %s codex-http request (%s): %s", verdict["decision"],
                        session_id, protocols.reasons(verdict))
            flow.response = self._deny(
                "openai.responses", verdict, protocols.wants_stream(body))

    async def _codex_http_response(self, flow: http.HTTPFlow) -> None:
        if flow.response is None or self._is_own_response(flow):
            return  # our own block/answer — never re-moderate it
        if flow.response.status_code != 200:
            return  # an upstream error — nothing to moderate
        session_id = (flow.metadata.get("ogr_codex_http_session")
                      or f"conn-{flow.client_conn.id}")
        authz = flow.metadata.get("ogr_codex_http_authz") or {}
        content_type = flow.response.headers.get("content-type", "")
        streaming = "event-stream" in content_type
        raw = flow.response.get_text() or ""

        body: dict | None = None
        if streaming:
            calls = []
            for frame in protocols.parse_sse_events(raw):
                call = protocols.parse_codex_ws_tool_call(frame)
                if call:
                    calls.append(call)
        else:
            try:
                parsed_body = json.loads(raw or "{}")
            except ValueError:
                parsed_body = None
            body = parsed_body if isinstance(parsed_body, dict) else None
            calls = protocols.tool_calls_from_output(body) if body else []

        for call in calls:
            event = make_event(
                "tool_call", subject=self._subject(),
                payload={"name": call["name"], "arguments": {"input": call["arguments"]},
                         "call_id": call["call_id"]},
                session_id=session_id, llm_protocol="openai.responses", authz=authz,
                provenance=[{"source": "model", "trust": "unverified"}])
            verdict = await self._evaluate(event)
            decision = (verdict or {}).get("decision") or ("block" if self.fail_closed else "allow")
            if decision in BLOCKING:
                reason = protocols.reasons(verdict or {})
                logger.info("[OGR] %s codex-http tool_call %s (%s): %s", decision,
                            call["name"], session_id, reason)
                # Unlike the WebSocket path there is no single frame to rewrite
                # or drop — the whole buffered response is one unit, so a block
                # replaces it outright (a typed 403, or a 代答/reason under an
                # answer mode).
                flow.response = self._deny(
                    "openai.responses", verdict or {"decision": decision}, streaming)
                return
            logger.info("[OGR] allow codex-http tool_call %s (%s)", call["name"], session_id)

        if not self.check_response or streaming or body is None:
            return  # streaming completion text: not moderated yet (same limitation as the other HTTP protocols)
        text = protocols.parse_response("openai.responses", body)
        if not text:
            return
        event = make_event(
            "model_output", subject=self._subject(), payload={"text": text},
            session_id=session_id, llm_protocol="openai.responses",
            provenance=[{"source": "model", "trust": "unverified"}])
        verdict = await self._evaluate(event)
        if verdict is None:
            if self.fail_closed:
                flow.response = self._fail_closed_block("openai.responses")
            return
        if verdict.get("decision") in BLOCKING:
            logger.info("[OGR] %s codex-http response (%s): %s", verdict["decision"],
                        session_id, protocols.reasons(verdict))
            flow.response = self._deny("openai.responses", verdict, streaming)

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
            "ogr_ws", {"transcript": [], "system_prompt": "", "verdicts": {},
                       "blocked_calls": set()})

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
            if out["call_id"] in st["blocked_calls"]:
                # This is our own block notice echoing back — not agent output.
                st["blocked_calls"].discard(out["call_id"])
                continue
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
            reason = protocols.reasons(verdict or {})
            logger.info("[OGR] %s codex-ws tool_call %s (%s): %s", decision,
                        call["name"], self._session(flow), reason)
            rewritten = (protocols.rewrite_codex_tool_call_block(frame, reason)
                         if self.ws_block_rewrite else None)
            if rewritten is not None:
                # Graceful block: Codex "runs" a harmless notice and reports it to
                # the user; the real command never executes. Skip re-judging the
                # notice when it comes back as this call's tool_result.
                msg.content = rewritten
                self._ws_state(flow)["blocked_calls"].add(call["call_id"])
            else:
                # No safe rewrite (e.g. a named function_call): drop + tear down.
                # Codex surfaces this as a failed turn — there is no clean 403 on a socket.
                msg.drop()
                flow.kill()
            return

        logger.info("[OGR] allow codex-ws tool_call %s (%s)", call["name"],
                    self._session(flow))
        self._ws_state(flow)["transcript"].append(
            protocols.transcript_entry("assistant", tool_name=call["name"],
                                       tool_input=call["arguments"]))


addons = [OGRGateway()]
