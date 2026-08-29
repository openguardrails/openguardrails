"""Shared test doubles for the hermes suite.

Lives under its own module name (NOT inside conftest) because the repo's
root pytest run collects several packages' suites in one process, and a
`from conftest import ...` resolves to whichever conftest.py got onto
sys.path first — a collision this file's unique name sidesteps.
"""
from __future__ import annotations

import json
import re
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

# schema/guard-event.schema.json `required`, verbatim — the event IS these
# fields and nothing else.
REQUIRED_FIELDS = {
    "kind", "step_id",
    "agent_id", "agent_type", "agent_workspace", "agent_user",
    "llm_protocol", "payload",
}

#: The OPTIONAL fields. ``integration`` (2026-08-17) is the reporter's own
#: build id; ``session_hint`` (2026-08-19) is the producer's opaque name for
#: the conversation — a grouping hint, sent whenever the vantage holds a
#: session and absent at the exec chokepoint, which holds none. ``connection``
#: is in the schema too but is a GATEWAY's field; this integration never sends
#: it, and the testkit deliberately keeps it out of the allowed set so a stray
#: copy here would fail loudly. ``redaction`` (OGR 1.4, plugin 2.0) is the
#: local-redaction report: the ruleset id this process runs and the tokens it
#: MINTED in this step — checked for shape below, and it must never carry a
#: value.
OPTIONAL_FIELDS = {"integration", "session_hint", "redaction"}

_TOKEN_RE = re.compile(r"^\$\{OGR_[A-Z_]+_[0-9A-Z]+\}$")

#: The inline ruleset the mock serves — three rules lifted from the runtime's
#: `entities.ts` (the openai prefix, the anthropic prefix, and the bearer
#: header with the value in group 1), in the served wire shape.
RULESET = {
    "id": "rs_test0000000000000000000000000001",
    "generated_at": "2026-08-28T00:00:00Z",
    "family": "secrets",
    "dialect": "ogr-re-1",
    "rules": [
        {
            "id": "entity_api_key",
            "category": "security.secret_leak.api_key",
            "severity": "critical",
            "tier": "strong",
            "flags": "",
            "patterns": [
                {"id": "openai",
                 "source": r"(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_\-]{20,}(?![A-Za-z0-9])"},
                {"id": "anthropic",
                 "source": r"(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_\-]{20,}(?![A-Za-z0-9])"},
            ],
            "examples": {
                "match": ["sk-proj-abcdefghijklmnopqrstuvwxyz0123",
                          "sk-ant-api03-abcdefghijklmnopqrstuvwxyz"],
                "nomatch": ["sk-${TOKEN}", "sk-…3ab", "xsk-abcdefghijklmnopqrstuvwxyz"],
            },
        },
        {
            "id": "entity_bearer_token",
            "category": "security.secret_leak.api_key",
            "severity": "critical",
            "tier": "strong",
            "flags": "i",
            "patterns": [
                {"id": "authorization_header",
                 "source": (r"(?<![A-Za-z0-9\-])(?:proxy-)?authorization\s*:\s*"
                            r"(?:bearer|basic|token|apikey)\s{1,4}"
                            r"(?!(?:your[_\-]|example|\$))"
                            r"(?![A-Za-z0-9._~+/\-]*(?:\.{3,}|…))"
                            r"([A-Za-z0-9._~+/\-]{12,}={0,2})")},
            ],
            "group": 1,
            "examples": {
                "match": ['curl -H "Authorization: Bearer pk_cc7f7b3f73664638b8f30fe8ca598848"',
                          "Proxy-Authorization: Basic dXNlcjpwYXNzd29yZDEyMw=="],
                "nomatch": ["Authorization: Bearer <YOUR_TOKEN>",
                            "Authorization: Bearer ${API_TOKEN}",
                            "Authorization: Bearer pk_cc7...8848"],
            },
        },
        {
            "id": "entity_password_assignment",
            "category": "security.secret_leak.password",
            "severity": "high",
            "tier": "heuristic",
            "flags": "i",
            "patterns": [
                {"id": "assignment",
                 "source": r"\bpassword\s*[:=]\s*[\"']?(?!\$)([^\s\"']{8,})"},
            ],
            "group": 1,
            "examples": {"match": ["password = hunter2hunter2"],
                         "nomatch": ["password = ${PASSWORD}", "password: short"]},
        },
    ],
}

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

    def __init__(self, ruleset: dict | None = None) -> None:
        self.events: list[dict] = []
        self.heartbeats: list[dict] = []
        self.violations: list[str] = []
        #: What GET /v1/rules serves (None = 404, as a runtime without the
        #: feed answers). `rules_requests` records each If-None-Match seen.
        self.ruleset = ruleset
        self.rules_requests: list[str] = []
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
                    served = (outer.ruleset or {}).get("id", "")
                    self._reply(200, {"ok": True, "rules": {"id": served}})
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

            def do_GET(self):
                if self.headers.get("Authorization") != f"Bearer {API_KEY}":
                    self._reply(401, {"error": "unauthorized"})
                    return
                if self.path != "/v1/rules" or outer.ruleset is None:
                    self._reply(404, {"error": "not_found"})
                    return
                inm = self.headers.get("If-None-Match", "")
                outer.rules_requests.append(inm)
                if inm.strip('"') == outer.ruleset["id"]:
                    self.send_response(304)
                    self.send_header("ETag", f'"{outer.ruleset["id"]}"')
                    self.end_headers()
                    return
                data = json.dumps({"ruleset": outer.ruleset}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("ETag", f'"{outer.ruleset["id"]}"')
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

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
        if "redaction" in event:
            problems.extend(self._check_redaction(event["redaction"]))
        return problems

    @staticmethod
    def _check_redaction(red) -> list[str]:
        if not isinstance(red, dict) or set(red) != {"ruleset", "masked"}:
            return [f"redaction: bad shape {red!r}"]
        problems = []
        if not isinstance(red["ruleset"], str):
            problems.append("redaction.ruleset: not a string")
        if not isinstance(red["masked"], list) or len(red["masked"]) > 256:
            return problems + ["redaction.masked: not a list (≤256)"]
        for m in red["masked"]:
            if not isinstance(m, dict) or set(m) != {"token", "rule"}:
                problems.append(f"redaction.masked entry: bad shape {m!r}")
            elif not _TOKEN_RE.match(m["token"]):
                # The report names TOKENS. Anything else here is a value
                # leaving the host inside the field that says it did not.
                problems.append(f"redaction.masked token: {m['token']!r}")
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
