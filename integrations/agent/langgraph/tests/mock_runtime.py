"""The strict mock runtime — the v0.8 contract made executable, offline.

It validates every received GuardEvent against the schema's EXACT required
set (``additionalProperties: false`` — nine required fields plus the one
optional ``integration``,
nothing extra) and RECORDS violations instead of merely 400-ing, because a
fail-open integration would swallow a 400 and a wire regression would
otherwise pass silently. Tests assert ``runtime.violations == []``.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

API_KEY = "ogr_test_key"

# The v0.8 GuardEvent: schema/guard-event.schema.json `required`, verbatim.
REQUIRED_FIELDS = {
    "kind",
    "step_id",
    "agent_id",
    "agent_type",
    "agent_workspace",
    "agent_user",
    "llm_protocol",
    "payload",
}

#: The one OPTIONAL field (2026-08-17): ``integration``, the reporter's own
#: ``"name/version"``. An ALLOWLIST, not a relaxation — an unknown key is still a
#: violation; only a MISSING ``integration`` stopped being one, which is what lets
#: a runtime and a reporter roll forward independently.
OPTIONAL_FIELDS = {"integration"}

KINDS = {"step/request", "step/response"}
LLM_PROTOCOLS = {"openai.chat", "openai.responses", "anthropic.messages", "canonical"}
FIVE_TUPLE = ("agent_id", "agent_type", "agent_workspace", "agent_user")


class MockRuntime:
    """A scriptable /v1/evaluate + /v1/heartbeat server on a loopback port."""

    def __init__(self) -> None:
        self.events: list[dict] = []
        self.heartbeats: list[dict] = []
        self.violations: list[str] = []
        self.verdicts: list[dict] = []  # FIFO script; empty → default allow
        self.fail_statuses: list[int] = []  # FIFO of statuses to answer with first
        self._served = 0

        runtime = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args) -> None:  # keep pytest output clean
                pass

            def _reply(self, status: int, body: dict) -> None:
                data = json.dumps(body).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"] or 0)))
                if self.headers.get("Authorization") != f"Bearer {API_KEY}":
                    runtime.violations.append(f"bad auth: {self.headers.get('Authorization')!r}")
                    self._reply(401, {"error": "unauthorized"})
                    return
                if runtime.fail_statuses:
                    self._reply(runtime.fail_statuses.pop(0), {"error": "scripted_failure"})
                    return
                if self.path == "/v1/heartbeat":
                    runtime.heartbeats.append(body)
                    self._reply(200, {"ok": True})
                    return
                if self.path != "/v1/evaluate":
                    self._reply(404, {"error": "not_found"})
                    return
                runtime._validate(body)
                runtime.events.append(body)
                runtime._served += 1
                verdict = runtime.verdicts.pop(0) if runtime.verdicts else {"decision": "allow"}
                verdict.setdefault("event_id", f"evt-{runtime._served}")
                verdict.setdefault("provider", "mock-runtime")
                self._reply(200, verdict)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def _validate(self, event: dict) -> None:
        keys = set(event)
        if keys < REQUIRED_FIELDS or keys - REQUIRED_FIELDS - OPTIONAL_FIELDS:
            self.violations.append(
                f"field set mismatch: missing={sorted(REQUIRED_FIELDS - keys)} "
                f"extra={sorted(keys - REQUIRED_FIELDS - OPTIONAL_FIELDS)}"
            )
            return
        if event["kind"] not in KINDS:
            self.violations.append(f"bad kind: {event['kind']!r}")
        if not isinstance(event["step_id"], str) or not event["step_id"]:
            self.violations.append(f"bad step_id: {event['step_id']!r}")
        for field in FIVE_TUPLE:
            if not isinstance(event[field], str):
                self.violations.append(f"{field} is not a string: {event[field]!r}")
        if event["llm_protocol"] not in LLM_PROTOCOLS:
            self.violations.append(f"bad llm_protocol: {event['llm_protocol']!r}")
        if not isinstance(event["payload"], dict):
            self.violations.append(f"payload is not an object: {type(event['payload'])}")

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
