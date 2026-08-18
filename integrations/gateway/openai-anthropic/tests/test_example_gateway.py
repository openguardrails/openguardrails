"""End-to-end offline tests for the one-file example gateway.

Everything is stdlib and local: a mock OGR runtime (records GuardEvents,
replays programmed Verdicts), a mock provider upstream (JSON or SSE), and the
real gateway server between them — so the tests exercise the exact byte path
a client sees, including the streamed tail-hold, with no network and no
mitmproxy/aiohttp/SDK anywhere.
"""
from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import gateway
from gateway import Config, TailHold, make_server


# ── mock servers ───────────────────────────────────────────────────────────

class MockRuntime:
    """A stdlib /v1/evaluate that records events and replays verdicts."""

    def __init__(self):
        self.requests: list[dict] = []
        self.verdicts: list[dict] = []   # popped per evaluate; empty → allow
        self.status = 200
        runtime = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("content-length", 0)))
                runtime.requests.append({"path": self.path,
                                         "headers": dict(self.headers),
                                         "raw": raw,
                                         "event": json.loads(raw)})
                if runtime.status != 200:
                    self.send_response(runtime.status)
                    self.end_headers()
                    return
                verdict = (runtime.verdicts.pop(0) if runtime.verdicts
                           else {"event_id": "evt-1", "provider": "mock",
                                 "decision": "allow"})
                data = json.dumps(verdict).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_port}"

    @property
    def events(self):
        return [r["event"] for r in self.requests
                if r["path"].endswith("/v1/evaluate")]

    def close(self):
        self.server.shutdown()
        self.server.server_close()


UPSTREAM_JSON = {"id": "chatcmpl-1", "model": "gpt-5",
                 "choices": [{"index": 0, "finish_reason": "stop",
                              "message": {"role": "assistant", "content": "hi"}}],
                 "usage": {"prompt_tokens": 3, "completion_tokens": 1}}

# "Hello" flows immediately; " wor" / "ld!!" / [DONE] sit inside a 5-char tail.
UPSTREAM_SSE = (
    b'data: {"model": "gpt-5", "choices": [{"index": 0, "delta": {"content": "Hello"}}]}\n\n'
    b'data: {"choices": [{"index": 0, "delta": {"content": " wor"}}]}\n\n'
    b'data: {"choices": [{"index": 0, "delta": {"content": "ld!!"}}]}\n\n'
    b'data: {"choices": [], "usage": {"prompt_tokens": 7, "completion_tokens": 3}}\n\n'
    b'data: [DONE]\n\n')


class MockUpstream:
    """A provider that answers JSON, or SSE when the request says stream."""

    def __init__(self):
        self.requests: list[dict] = []
        self.json_body = UPSTREAM_JSON
        self.sse_body = UPSTREAM_SSE
        upstream = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("content-length", 0)))
                body = json.loads(raw)
                upstream.requests.append({"path": self.path,
                                          "headers": dict(self.headers),
                                          "body": body})
                if body.get("stream"):
                    self.send_response(200)
                    self.send_header("content-type", "text/event-stream")
                    self.end_headers()
                    self.wfile.write(upstream.sse_body)
                    return
                data = json.dumps(upstream.json_body).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture()
def runtime():
    rt = MockRuntime()
    yield rt
    rt.close()


@pytest.fixture()
def upstream():
    up = MockUpstream()
    yield up
    up.close()


@pytest.fixture()
def gw(runtime, upstream):
    """The real gateway, wired to the two mocks, tail small enough to test."""
    cfg = Config(ogr_url=runtime.url, ogr_api_key="ogr_test",
                 agent_id="edge-gw", agent_type="example",
                 agent_workspace="gw-tests", agent_user="",
                 tail=5, upstream_openai=upstream.url,
                 upstream_anthropic=upstream.url)
    server = make_server(cfg, port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server
    server.shutdown()
    server.server_close()


def call(server, path, body, headers=None):
    """POST through the gateway; (status, raw_bytes). A refused request comes
    back as an HTTPError, which is still a readable response."""
    req = urllib.request.Request(
        f"http://127.0.0.1:{server.server_port}{path}",
        data=json.dumps(body).encode(), method="POST",
        headers={"content-type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as err:
        with err:
            return err.status, err.read()


CHAT = {"model": "gpt-5", "messages": [{"role": "user", "content": "hello"}]}


# ── the recipe, non-streamed ───────────────────────────────────────────────

def test_allow_roundtrip_two_events_one_step(gw, runtime, upstream):
    status, raw = call(gw, "/v1/chat/completions", CHAT,
                       headers={"authorization": "Bearer sk-client"})
    assert status == 200
    assert json.loads(raw) == UPSTREAM_JSON          # delivered untouched
    # the client's own provider credential was forwarded, not swallowed
    assert upstream.requests[0]["headers"].get("Authorization") == "Bearer sk-client"

    req_event, resp_event = runtime.events
    # The nine required fields plus `integration`, the ONE optional one (restored
    # 2026-08-17: the heartbeat's record is keyed on the integration NAME, so it
    # reports whichever replica beat last and cannot name the build behind traffic).
    for event in (req_event, resp_event):
        assert set(event) == {"kind", "step_id", "agent_id", "agent_type",
                              "agent_workspace", "agent_user",
                              "llm_protocol", "payload", "integration"}
        assert event["integration"] == gateway.INTEGRATION
        assert event["agent_id"] == "edge-gw"
        assert event["agent_user"] == ""              # '' is still an assertion
    assert req_event["kind"] == "step/request"
    assert req_event["payload"] == CHAT               # raw body, undecomposed
    assert resp_event["kind"] == "step/response"
    assert resp_event["step_id"] == req_event["step_id"]  # one step, two halves
    timing = resp_event["payload"]["timing"]          # byte-spliced onto the raw body
    assert timing["started_at"] and timing["completed_at"]
    assert "first_token_at" not in timing             # buffered replies omit it
    assert runtime.requests[0]["headers"].get("Authorization") == "Bearer ogr_test"


def test_block_on_request_never_calls_the_provider(gw, runtime, upstream):
    runtime.verdicts.append({"event_id": "evt-9", "provider": "mock",
                             "decision": "block",
                             "findings": [{"category": "security.prompt_injection"}]})
    status, raw = call(gw, "/v1/chat/completions", CHAT)
    assert status == 403
    body = json.loads(raw)
    assert body["error"]["code"] == "guardrails_blocked"
    assert "security.prompt_injection" in body["error"]["message"]
    assert not upstream.requests                     # the model was never called


def test_block_on_response_withholds_the_answer(gw, runtime, upstream):
    runtime.verdicts.append({"event_id": "e1", "provider": "mock", "decision": "allow"})
    runtime.verdicts.append({"event_id": "e2", "provider": "mock", "decision": "block"})
    status, raw = call(gw, "/v1/chat/completions", CHAT)
    assert status == 403
    assert b'"hi"' not in raw                        # the completion never leaked
    assert upstream.requests                         # upstream WAS called; its answer was refused


def test_anthropic_route_and_refusal_shape(gw, runtime):
    runtime.verdicts.append({"event_id": "e", "provider": "mock", "decision": "block"})
    status, raw = call(gw, "/v1/messages", {"model": "claude", "messages": []})
    assert status == 403
    body = json.loads(raw)
    assert body["type"] == "error"                   # Anthropic callers get Anthropic errors
    assert runtime.events[0]["llm_protocol"] == "anthropic.messages"


def test_request_spans_are_applied_before_forwarding(gw, runtime, upstream):
    runtime.verdicts.append({
        "event_id": "e", "provider": "mock", "decision": "allow",
        "modifications": {"spans": [{"path": "payload.messages.0.content",
                                     "start": 0, "end": 5,
                                     "replacement": "${OGR_1}"}]}})
    call(gw, "/v1/chat/completions", CHAT)
    sent = upstream.requests[0]["body"]
    assert sent["messages"][0]["content"] == "${OGR_1}"


def test_unknown_route_404s(gw, runtime):
    status, _ = call(gw, "/v1/embeddings", {"input": "x"})
    assert status == 404
    assert not runtime.events                        # not LLM traffic, not judged


# ── degraded mode ──────────────────────────────────────────────────────────

def test_fail_open_is_the_default(gw, runtime, upstream):
    runtime.status = 500                             # the runtime is dark
    status, raw = call(gw, "/v1/chat/completions", CHAT)
    assert status == 200                             # traffic proceeds…
    assert json.loads(raw) == UPSTREAM_JSON
    assert gw.counters["unchecked"] == 2             # …but both unjudged halves are counted


def test_fail_closed_refuses_while_dark(gw, runtime, upstream):
    gw.cfg.fail_mode = "closed"
    runtime.status = 500
    status, _ = call(gw, "/v1/chat/completions", CHAT)
    assert status == 503
    assert not upstream.requests


def test_unjudged_paths_refuse_under_fail_closed(gw, runtime):
    gw.cfg.fail_mode = "closed"
    runtime.verdicts.append({"event_id": "e", "provider": "mock",
                             "decision": "allow", "unjudged": ["payload.text"]})
    status, _ = call(gw, "/v1/chat/completions", CHAT)
    assert status == 503                             # "could not look" ≠ "found nothing"


# ── streaming: hold the tail, judge once ───────────────────────────────────

def test_streamed_allow_delivers_everything_and_judges_once(gw, runtime):
    status, raw = call(gw, "/v1/chat/completions", {**CHAT, "stream": True})
    assert status == 200
    assert raw == UPSTREAM_SSE                       # tail released byte-identical
    assert len(runtime.events) == 2                  # one evaluate for the whole stream
    event = runtime.events[1]
    assert event["llm_protocol"] == "canonical"      # no single raw body existed
    payload = event["payload"]
    assert payload["text"] == "Hello world!!"
    assert payload["usage"] == {"input_tokens": 7, "output_tokens": 3}
    assert payload["timing"]["first_token_at"]       # streams observe first-token


def test_streamed_block_cuts_the_stream_before_the_tail(gw, runtime):
    runtime.verdicts.append({"event_id": "e1", "provider": "mock", "decision": "allow"})
    runtime.verdicts.append({"event_id": "e2", "provider": "mock", "decision": "block"})
    status, raw = call(gw, "/v1/chat/completions", {**CHAT, "stream": True})
    assert status == 200                             # the 200 was long gone; the CUT is the refusal
    text = raw.decode()
    assert "Hello" in text                           # content ahead of the tail was seen
    assert "ld!!" not in text                        # the held tail never left
    assert "[DONE]" not in text                      # the stream never completes…
    assert gw.counters["stream_stopped"] == 1        # …and the cut is counted


def test_tail_inf_degenerates_to_buffering(runtime, upstream):
    cfg = Config(ogr_url=runtime.url, ogr_api_key="k", tail=float("inf"),
                 upstream_openai=upstream.url, upstream_anthropic=upstream.url)
    server = make_server(cfg, port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        runtime.verdicts.append({"event_id": "e1", "provider": "mock", "decision": "allow"})
        runtime.verdicts.append({"event_id": "e2", "provider": "mock", "decision": "block"})
        _, raw = call(server, "/v1/chat/completions", {**CHAT, "stream": True})
        assert raw == b""                            # nothing at all reached the client
    finally:
        server.shutdown()
        server.server_close()


def test_tailhold_releases_only_when_enough_is_held_behind():
    out: list[bytes] = []
    hold = TailHold(5, out.append)
    hold.add(b"A", 5)                                # 5 held; nothing behind it yet
    hold.add(b"B", 4)
    assert out == []                                 # 4 chars behind A: still short of 5
    hold.add(b"C", 4)                                # 8 chars behind A: A may leave
    assert out == [b"A"]
    hold.add(b"D", 0)                                # terminal frames carry 0 chars…
    assert out == [b"A"]                             # …and can never push the tail out
    hold.release()
    assert out == [b"A", b"B", b"C", b"D"]


ANTHROPIC_SSE = (
    b'event: message_start\n'
    b'data: {"type": "message_start", "message": {"model": "claude-x",'
    b' "usage": {"input_tokens": 4}}}\n\n'
    b'event: content_block_delta\n'
    b'data: {"type": "content_block_delta", "index": 0,'
    b' "delta": {"type": "text_delta", "text": "The full answer"}}\n\n'
    b'event: message_delta\n'
    b'data: {"type": "message_delta", "usage": {"output_tokens": 6}}\n\n'
    b'event: message_stop\n'
    b'data: {"type": "message_stop"}\n\n')


def test_streamed_anthropic_reassembles_and_merges_usage(gw, runtime, upstream):
    upstream.sse_body = ANTHROPIC_SSE
    status, raw = call(gw, "/v1/messages",
                       {"model": "claude-x", "stream": True, "messages": []})
    assert status == 200
    assert raw == ANTHROPIC_SSE
    payload = runtime.events[1]["payload"]
    assert payload["text"] == "The full answer"
    assert payload["usage"] == {"input_tokens": 4, "output_tokens": 6}


# ── wire helpers ───────────────────────────────────────────────────────────

def test_timing_is_byte_spliced_never_reserialized(gw, runtime, upstream):
    # A pre-escaped unicode string in the provider reply must survive verbatim
    # in the POSTed event bytes: the payload is spliced, not decoded/re-encoded.
    upstream.json_body = {"note": "café", "choices": []}
    # Recreate the exact escaped wire form the mock will send:
    upstream_raw = json.dumps(upstream.json_body)    # ensure_ascii → café
    assert "\\u00e9" in upstream_raw
    call(gw, "/v1/chat/completions", CHAT)
    assert b"caf\\u00e9" in runtime.requests[1]["raw"]
    assert runtime.events[1]["payload"]["note"] == "café"
