"""Test bootstrap: importable package, fake litellm, offline mock runtime.

The suite must run FULLY OFFLINE and without litellm installed:

- the package directory is put on ``sys.path`` so the tests work both as
  ``python -m pytest integrations/agent/litellm`` from the repo root and as
  a bare ``python -m pytest`` from inside this directory;
- a fake ``litellm`` module tree is injected into ``sys.modules`` BEFORE the
  package is imported (hooks.py resolves ``CustomLogger`` at import time),
  and it is injected unconditionally so a locally-installed litellm cannot
  make the suite behave differently on different machines;
- the mock runtime is a stdlib ``http.server`` speaking just enough of the
  v0.8 Runtime API: it validates every /v1/evaluate body STRICTLY against
  the ten-field GuardEvent shape (exact key set, no extras) and answers with
  whatever verdict the test scripted.
"""

import json
import os
import socket
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# ── fake litellm, injected before openguardrails_litellm ever imports ─────


def _fake_stream_chunk_builder(chunks, messages=None):
    """A minimal stand-in for litellm.stream_chunk_builder: concatenates
    delta content into one openai.chat completion body."""
    text = ""
    model = ""
    finish = "stop"
    for chunk in chunks:
        model = chunk.get("model") or model
        for choice in chunk.get("choices") or []:
            delta = choice.get("delta") or {}
            text += delta.get("content") or ""
            if choice.get("finish_reason"):
                finish = choice["finish_reason"]
    return {
        "id": "chatcmpl-rebuilt",
        "object": "chat.completion",
        "model": model,
        "choices": [
            {
                "index": 0,
                "finish_reason": finish,
                "message": {"role": "assistant", "content": text},
            }
        ],
    }


def _install_fake_litellm():
    litellm = types.ModuleType("litellm")
    integrations = types.ModuleType("litellm.integrations")
    custom_logger = types.ModuleType("litellm.integrations.custom_logger")

    class CustomLogger:
        """Shape-compatible base: the real one's hooks are all no-ops."""

        def __init__(self, message_logging=True, **kwargs):
            self.message_logging = message_logging

    custom_logger.CustomLogger = CustomLogger
    integrations.custom_logger = custom_logger
    litellm.integrations = integrations
    litellm.stream_chunk_builder = _fake_stream_chunk_builder
    litellm.callbacks = []
    sys.modules["litellm"] = litellm
    sys.modules["litellm.integrations"] = integrations
    sys.modules["litellm.integrations.custom_logger"] = custom_logger


_install_fake_litellm()
for _mod in [m for m in list(sys.modules) if m.startswith("openguardrails_litellm")]:
    del sys.modules[_mod]  # make sure the package binds to the fake base

# ── mock v0.8 runtime ─────────────────────────────────────────────────────

EVENT_FIELDS = {
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

IDENTITY_FIELDS = (
    "agent_id", "agent_type", "agent_workspace", "agent_user",
)


def validate_event(body):
    """STRICT v0.8: the nine required fields (plus the optional
    `integration`), correct enums and types."""
    errors = []
    if not isinstance(body, dict):
        return ["body is not an object"]
    keys = set(body)
    if keys < EVENT_FIELDS or keys - EVENT_FIELDS - OPTIONAL_FIELDS:
        errors.append(
            f"key set mismatch: extra={sorted(keys - EVENT_FIELDS - OPTIONAL_FIELDS)} "
            f"missing={sorted(EVENT_FIELDS - keys)}"
        )
        return errors
    if body["kind"] not in ("step/request", "step/response"):
        errors.append(f"bad kind {body['kind']!r}")
    if not isinstance(body["step_id"], str) or not body["step_id"]:
        errors.append("step_id must be a non-empty string")
    for field in IDENTITY_FIELDS:
        if not isinstance(body[field], str):
            errors.append(f"{field} must be a string")
    if body["llm_protocol"] not in (
        "openai.chat", "openai.responses", "anthropic.messages", "canonical",
    ):
        errors.append(f"bad llm_protocol {body['llm_protocol']!r}")
    if not isinstance(body["payload"], dict):
        errors.append("payload must be an object")
    return errors


def allow_verdict(event):
    return 200, {
        "event_id": "evt_" + event.get("step_id", "?")[:8],
        "provider": "mock-runtime",
        "decision": "allow",
    }


class MockRuntime:
    """A scriptable v0.8 runtime: set ``responder`` to shape verdicts."""

    def __init__(self):
        self.requests = []       # every POST: {path, auth, body}
        self.schema_errors = []  # strict-validation failures
        self.responder = allow_verdict
        self._server = None
        self._thread = None

    @property
    def url(self):
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    @property
    def events(self):
        return [r["body"] for r in self.requests if r["path"] == "/v1/evaluate"]

    def block(self, on_kind=None, findings=None):
        """Script a block verdict (optionally only for one event kind)."""

        def responder(event):
            if on_kind is None or event.get("kind") == on_kind:
                return 200, {
                    "event_id": "evt_block",
                    "provider": "mock-runtime",
                    "decision": "block",
                    "findings": findings or [
                        {"category": "security.cmd.data_exfiltration",
                         "severity": "critical", "action": "block"}
                    ],
                }
            return allow_verdict(event)

        self.responder = responder

    def start(self):
        runtime = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                runtime.requests.append({
                    "path": self.path,
                    "auth": self.headers.get("Authorization"),
                    "body": body,
                })
                if self.path == "/v1/evaluate":
                    errors = validate_event(body)
                    if errors:
                        runtime.schema_errors.append({"errors": errors,
                                                      "body": body})
                        status, payload = 400, {"error": "invalid_event",
                                                "details": errors}
                    else:
                        status, payload = runtime.responder(body)
                elif self.path == "/v1/heartbeat":
                    status, payload = 200, {"ok": True}
                else:
                    status, payload = 404, {"error": "not_found"}
                raw = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args):
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever,
                                        daemon=True)
        self._thread.start()

    def stop(self):
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


# ── fixtures ──────────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def clean_ogr_env(monkeypatch):
    """Determinism: no OGR_* from the developer's shell leaks into a test."""
    for name in list(os.environ):
        if name.startswith("OGR_"):
            monkeypatch.delenv(name, raising=False)


@pytest.fixture
def runtime():
    rt = MockRuntime()
    rt.start()
    yield rt
    rt.stop()
    assert rt.schema_errors == [], rt.schema_errors


@pytest.fixture
def dead_url():
    """A URL nothing listens on — connection refused, immediately."""
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return f"http://127.0.0.1:{port}"


@pytest.fixture
def make_guard(runtime):
    """An OpenGuardrails wired to the mock runtime (overridable)."""
    from openguardrails_litellm import OpenGuardrails

    def factory(**overrides):
        config = dict(runtime_url=runtime.url, api_key="ogr_test_key",
                      agent_id="test-agent", timeout=2.0)
        config.update(overrides)
        return OpenGuardrails(**config)

    return factory
