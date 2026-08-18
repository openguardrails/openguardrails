"""Shared test doubles for the hermes suite.

Lives under its own module name (NOT inside conftest) because the repo's
root pytest run collects several packages' suites in one process, and a
`from conftest import ...` resolves to whichever conftest.py got onto
sys.path first — a collision this file's unique name sidesteps.
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

# schema/guard-event.schema.json `required`, verbatim — the event IS these
# fields and nothing else.
REQUIRED_FIELDS = {
    "kind", "step_id",
    "agent_id", "agent_type", "agent_workspace", "agent_user",
    "llm_protocol", "payload",
}

#: The one OPTIONAL field (2026-08-17): ``integration``, the reporter's own
#: ``"name/version"``. An ALLOWLIST, not a relaxation — an unknown key is still a
#: violation; only a MISSING ``integration`` stopped being one, which is what lets
#: a runtime and a reporter roll forward independently.
OPTIONAL_FIELDS = {"integration"}

KINDS = {"step/request", "step/response"}
PROTOCOLS = {"openai.chat", "openai.responses", "anthropic.messages", "canonical"}

API_KEY = "test-key"


class MockRuntime:
    """One /v1/evaluate + /v1/heartbeat server on an ephemeral port.

    `decide` maps an accepted GuardEvent to the Verdict to return; tests
    override it per case. Every wire violation lands in `violations`, and the
    `guarded` fixture asserts that list empty at teardown — so no individual
    test can forget to check conformance.
    """

    def __init__(self) -> None:
        self.events: list[dict] = []
        self.heartbeats: list[dict] = []
        self.violations: list[str] = []
        self.decide = lambda event: {
            "event_id": f"evt-{len(self.events)}", "provider": "mock", "decision": "allow",
        }
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # keep pytest output clean
                pass

            def _reply(self, status: int, body: dict) -> None:
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                if self.headers.get("Authorization") != f"Bearer {API_KEY}":
                    self._reply(401, {"error": "unauthorized"})
                    return
                raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                body = json.loads(raw)
                if self.path == "/v1/heartbeat":
                    outer.heartbeats.append(body)
                    self._reply(200, {"ok": True})
                    return
                if self.path != "/v1/evaluate":
                    self._reply(404, {"error": "not_found"})
                    return
                problems = outer._check(body)
                if problems:
                    outer.violations.extend(problems)
                    self._reply(400, {"error": "invalid_event", "details": problems})
                    return
                outer.events.append(body)
                self._reply(200, outer.decide(body))

        self.httpd = HTTPServer(("127.0.0.1", 0), Handler)
        # Tight poll: shutdown() blocks a full poll interval, and the default
        # 0.5s would tax every test's teardown for nothing.
        threading.Thread(target=lambda: self.httpd.serve_forever(poll_interval=0.02),
                         daemon=True).start()

    def _check(self, event: dict) -> list[str]:
        problems = []
        keys = set(event)
        if keys < REQUIRED_FIELDS or keys - REQUIRED_FIELDS - OPTIONAL_FIELDS:
            missing = REQUIRED_FIELDS - keys
            extra = keys - REQUIRED_FIELDS - OPTIONAL_FIELDS
            problems.append(f"fields: missing={sorted(missing)} extra={sorted(extra)}")
        if event.get("kind") not in KINDS:
            problems.append(f"kind: {event.get('kind')!r}")
        if event.get("llm_protocol") not in PROTOCOLS:
            problems.append(f"llm_protocol: {event.get('llm_protocol')!r}")
        if not (isinstance(event.get("step_id"), str) and event.get("step_id")):
            problems.append("step_id: empty or not a string")
        for field in ("agent_id", "agent_type", "agent_workspace",
                      "agent_user"):
            if not isinstance(event.get(field), str):
                problems.append(f"{field}: not a string")
        if not isinstance(event.get("payload"), dict):
            problems.append("payload: not an object")
        return problems

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


class FakeToolCall:
    """The SDK shape Hermes hands post_api_request: .id + nested .function."""

    def __init__(self, id_: str, name: str, arguments: str):
        self.id = id_
        self.function = type("Fn", (), {"name": name, "arguments": arguments})()


def assistant(text: str = "", tool_calls=None, reasoning: str = ""):
    """A stand-in assistant_message, attribute-shaped like Hermes' own."""
    msg = type("AssistantMessage", (), {})()
    msg.content = text
    msg.reasoning_content = reasoning
    msg.tool_calls = tool_calls or []
    return msg
