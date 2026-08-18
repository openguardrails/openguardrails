"""Offline tests for the v0.8 mitmproxy addon — no mitmproxy, no upstream LLM.

The hook logic is driven directly with fabricated flow objects, and the OGR
runtime is a stdlib mock HTTP server that records every GuardEvent it is sent
and answers a programmed Verdict — so the tests assert the WIRE (exactly the
ten v0.8 fields, raw bodies, byte-spliced timing) and the ENFORCEMENT (block,
fail modes, spans), not mitmproxy internals. One optional test exercises the
real mitmproxy types and skips when mitmproxy is not installed.
"""
from __future__ import annotations

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

import addon
from addon import INTEGRATION, OGRGateway


# ── the mock runtime (PDP) ─────────────────────────────────────────────────

class MockRuntime:
    """A stdlib /v1/evaluate that records requests and replays verdicts."""

    def __init__(self):
        self.requests: list[dict] = []      # {"path", "headers", "raw", "event"}
        self.verdicts: list[dict] = []      # popped per evaluate; empty → allow
        self.status = 200
        runtime = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                raw = self.rfile.read(int(self.headers.get("content-length", 0)))
                runtime.requests.append({
                    "path": self.path,
                    "headers": dict(self.headers),
                    "raw": raw,
                    "event": json.loads(raw),
                })
                if runtime.status != 200:
                    self.send_response(runtime.status)
                    self.end_headers()
                    return
                verdict = (runtime.verdicts.pop(0) if runtime.verdicts
                           else {"event_id": "evt-1", "provider": "mock",
                                 "decision": "allow"})
                body = json.dumps(verdict).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):  # keep pytest output clean
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    @property
    def events(self) -> list[dict]:
        return [r["event"] for r in self.requests]


@pytest.fixture()
def runtime():
    rt = MockRuntime()
    yield rt
    rt.close()


FIVE_TUPLE = {"ogr_agent_id": "proxy-agent", "ogr_agent_type": "mitmproxy",
              "ogr_agent_workspace": "gw-tests",
              "ogr_agent_user": ""}


@pytest.fixture()
def gateway(runtime):
    return OGRGateway(ogr_url=runtime.url, ogr_api_key="ogr_test",
                      ogr_timeout=5.0, **FIVE_TUPLE)


# ── fabricated flow objects (duck-typed to what the addon reads) ───────────

class FakeRequest:
    def __init__(self, path: str, body, method: str = "POST"):
        self.path, self.method = path, method
        self._text = body if isinstance(body, str) else json.dumps(body)

    def get_text(self):
        return self._text

    def set_text(self, text):
        self._text = text


class FakeResponse:
    def __init__(self, body, status_code: int = 200, content_type: str = "application/json"):
        self.status_code = status_code
        self.headers = {"content-type": content_type}
        self._text = body if isinstance(body, str) else json.dumps(body)

    def get_text(self):
        return self._text

    def set_text(self, text):
        self._text = text


class FakeFlow:
    def __init__(self, path: str, body, method: str = "POST"):
        self.request = FakeRequest(path, body, method)
        self.response = None
        self.metadata: dict = {}


def run(coro):
    return asyncio.run(coro)


CHAT_BODY = {"model": "gpt-5", "messages": [
    {"role": "system", "content": "be nice"},
    {"role": "user", "content": "hello"}]}


def roundtrip(gateway, flow, response_body, content_type="application/json"):
    """Drive both hooks: the request half, then attach an upstream response."""
    run(gateway.request(flow))
    assert flow.response is None, "request half unexpectedly refused"
    flow.response = FakeResponse(response_body, content_type=content_type)
    run(gateway.response(flow))


# ── protocol detection ─────────────────────────────────────────────────────

def test_match_protocol():
    assert addon.match_protocol("/v1/chat/completions") == "openai.chat"
    assert addon.match_protocol("/openai/v1/chat/completions?x=1") == "openai.chat"
    assert addon.match_protocol("/v1/responses") == "openai.responses"
    assert addon.match_protocol("/v1/messages") == "anthropic.messages"
    assert addon.match_protocol("/v1/embeddings") is None


# ── the wire: exactly the v0.8 event, nothing else ─────────────────────────

def test_request_event_is_exactly_v08(gateway, runtime):
    flow = FakeFlow("/v1/chat/completions", CHAT_BODY)
    run(gateway.request(flow))
    assert flow.response is None            # allow → forwarded
    (req,) = runtime.requests
    assert req["path"] == "/v1/evaluate"
    assert req["headers"].get("Authorization") == "Bearer ogr_test"
    event = req["event"]
    # The nine required fields plus `integration`, the ONE optional one (restored
    # 2026-08-17: the heartbeat's record is keyed on the integration NAME, so it
    # reports whichever replica beat last and cannot say which build produced a
    # given piece of traffic). Nothing else v0.8 removed may reappear.
    assert set(event) == {"kind", "step_id", "agent_id", "agent_type",
                          "agent_workspace", "agent_user",
                          "llm_protocol", "payload", "integration"}
    assert event["integration"] == INTEGRATION
    assert event["kind"] == "step/request"
    assert event["llm_protocol"] == "openai.chat"
    assert event["payload"] == CHAT_BODY    # the raw body, undecomposed
    assert event["agent_id"] == "proxy-agent"
    assert event["agent_user"] == ""        # '' is an assertion, still present
    assert event["step_id"]


def test_step_id_binds_both_halves_and_timing_is_spliced(gateway, runtime):
    flow = FakeFlow("/v1/chat/completions", CHAT_BODY)
    # A raw body with a pre-escaped unicode string: if the addon re-serialized
    # the payload, "café" would come back as UTF-8 "café" — the raw bytes
    # must instead travel through the event exactly as transported.
    response_raw = ('{"id": "chatcmpl-1", "model": "gpt-5", "note": "caf\\u00e9",'
                    ' "choices": [{"index": 0, "finish_reason": "stop",'
                    ' "message": {"role": "assistant", "content": "hi"}}],'
                    ' "usage": {"prompt_tokens": 3, "completion_tokens": 1}}')
    roundtrip(gateway, flow, response_raw)
    req_event, resp_event = runtime.events
    assert resp_event["kind"] == "step/response"
    assert resp_event["step_id"] == req_event["step_id"]
    # timing was byte-inserted as a top-level key; the rest is untouched
    timing = resp_event["payload"]["timing"]
    assert timing["started_at"] and timing["completed_at"]
    assert "first_token_at" not in timing   # buffered replies omit it
    assert resp_event["payload"]["usage"] == {"prompt_tokens": 3,
                                              "completion_tokens": 1}
    # the pre-escaped form survives verbatim in the POSTed bytes: the payload
    # was byte-spliced into the event, never decoded and re-encoded
    assert b'caf\\u00e9' in runtime.requests[1]["raw"]
    assert resp_event["payload"]["note"] == "café"


def test_provider_timing_key_is_left_alone(gateway, runtime):
    flow = FakeFlow("/v1/chat/completions", CHAT_BODY)
    roundtrip(gateway, flow, {"timing": {"vendor": "custom"}, "choices": []})
    assert runtime.events[1]["payload"]["timing"] == {"vendor": "custom"}


# ── enforcement: block ─────────────────────────────────────────────────────

def test_block_on_request_never_forwards(gateway, runtime):
    runtime.verdicts.append({"event_id": "evt-9", "provider": "mock",
                             "decision": "block",
                             "findings": [{"category": "security.prompt_injection",
                                           "action": "block"}]})
    flow = FakeFlow("/v1/chat/completions", CHAT_BODY)
    run(gateway.request(flow))
    assert flow.response is not None        # refused in place of forwarding
    assert flow.response.status_code == 403
    body = json.loads(flow.response.get_text())
    assert body["error"]["code"] == "guardrails_blocked"
    assert "security.prompt_injection" in body["error"]["message"]
    assert flow.response.headers["x-ogr-decision"] == "block"
    assert flow.response.headers["x-ogr-event-id"] == "evt-9"
    assert gateway.counters["refused"] == 1


def test_block_on_response_withholds_the_answer(gateway, runtime):
    runtime.verdicts.append({"event_id": "e1", "provider": "mock", "decision": "allow"})
    runtime.verdicts.append({"event_id": "e2", "provider": "mock", "decision": "block"})
    flow = FakeFlow("/v1/chat/completions", CHAT_BODY)
    roundtrip(gateway, flow, {"choices": [{"message": {
        "role": "assistant", "content": "rm -rf together",
        "tool_calls": [{"id": "c1", "type": "function",
                        "function": {"name": "bash",
                                     "arguments": "{\"command\": \"rm -rf /\"}"}}]}}]})
    assert flow.response.status_code == 403  # the model's answer never reaches the agent


def test_anthropic_refusal_is_anthropic_shaped(gateway, runtime):
    runtime.verdicts.append({"event_id": "e", "provider": "mock", "decision": "block"})
    flow = FakeFlow("/v1/messages", {"model": "claude", "messages": []})
    run(gateway.request(flow))
    body = json.loads(flow.response.get_text())
    assert body["type"] == "error"
    assert body["error"]["type"] == "forbidden"


def test_own_refusal_is_never_rejudged(gateway, runtime):
    runtime.verdicts.append({"event_id": "e", "provider": "mock", "decision": "block"})
    flow = FakeFlow("/v1/chat/completions", CHAT_BODY)
    run(gateway.request(flow))
    refusal = flow.response
    run(gateway.response(flow))             # mitmproxy fires this on our refusal too
    assert flow.response is refusal
    assert len(runtime.requests) == 1       # no second evaluate


# ── degraded mode ──────────────────────────────────────────────────────────

def test_fail_open_is_the_default_and_counts_unchecked():
    gw = OGRGateway(ogr_url="http://127.0.0.1:1", ogr_api_key="k",
                    ogr_timeout=0.2, **FIVE_TUPLE)
    assert gw.ogr_fail_mode == "open"
    flow = FakeFlow("/v1/chat/completions", CHAT_BODY)
    run(gw.request(flow))
    assert flow.response is None            # proceeds unjudged…
    assert gw.counters["unchecked"] == 1    # …but counted, never silent


def test_fail_closed_refuses_without_a_verdict():
    gw = OGRGateway(ogr_url="http://127.0.0.1:1", ogr_api_key="k",
                    ogr_timeout=0.2, ogr_fail_mode="closed", **FIVE_TUPLE)
    flow = FakeFlow("/v1/chat/completions", CHAT_BODY)
    run(gw.request(flow))
    assert flow.response.status_code == 503


def test_5xx_is_an_outage_not_an_allow(gateway, runtime):
    runtime.status = 500
    gateway.ogr_fail_mode = "closed"
    flow = FakeFlow("/v1/chat/completions", CHAT_BODY)
    run(gateway.request(flow))
    assert flow.response.status_code == 503


def test_unjudged_paths_refuse_under_fail_closed(gateway, runtime):
    # The verdict answered, but could not look at everything: under closed,
    # "could not look" is not "found nothing".
    runtime.verdicts.append({"event_id": "e", "provider": "mock",
                             "decision": "allow",
                             "unjudged": ["payload.tool_calls.0.arguments"]})
    gateway.ogr_fail_mode = "closed"
    flow = FakeFlow("/v1/chat/completions", CHAT_BODY)
    run(gateway.request(flow))
    assert flow.response.status_code == 503
    assert "partial" in json.loads(flow.response.get_text())["error"]["message"]


# ── redaction spans ────────────────────────────────────────────────────────

def test_spans_are_applied_before_the_body_is_forwarded(gateway, runtime):
    runtime.verdicts.append({
        "event_id": "e", "provider": "mock", "decision": "allow",
        "modifications": {"spans": [
            {"path": "payload.messages.1.content", "start": 3, "end": 8,
             "replacement": "${OGR_SECRET_1}"},
            {"path": "payload.messages.9.content", "start": 0, "end": 1,
             "replacement": "x"}]}})   # names nothing this body holds
    body = {"model": "gpt-5", "messages": [
        {"role": "system", "content": "be nice"},
        {"role": "user", "content": "my sk-99 key"}]}
    flow = FakeFlow("/v1/chat/completions", body)
    run(gateway.request(flow))
    forwarded = json.loads(flow.request.get_text())
    assert forwarded["messages"][1]["content"] == "my ${OGR_SECRET_1} key"
    assert gateway.counters["unresolved_spans"] == 1  # dropped AND counted


def test_apply_spans_highest_offset_first():
    body = {"text": "aaa bbb ccc"}
    n = addon.apply_spans(body, [
        {"path": "payload.text", "start": 0, "end": 3, "replacement": "X"},
        {"path": "payload.text", "start": 8, "end": 11, "replacement": "Y"}])
    assert n == 0
    assert body["text"] == "X bbb Y"       # both landed where they were computed


# ── streaming: buffered whole (tail = ∞), judged once ──────────────────────

OPENAI_SSE = (
    'data: {"model": "gpt-5", "choices": [{"index": 0, "delta": {"role": "assistant"}}]}\n\n'
    'data: {"choices": [{"index": 0, "delta": {"content": "Hello "}}]}\n\n'
    'data: {"choices": [{"index": 0, "delta": {"content": "world"}}]}\n\n'
    'data: {"choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "id": "c1",'
    ' "function": {"name": "bash", "arguments": "{\\"comm"}}]}}]}\n\n'
    'data: {"choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0,'
    ' "function": {"arguments": "and\\": \\"ls\\"}"}}]}}]}\n\n'
    'data: {"choices": [], "usage": {"prompt_tokens": 7, "completion_tokens": 4}}\n\n'
    'data: [DONE]\n\n')


def test_openai_stream_reassembles_to_one_canonical_event(gateway, runtime):
    flow = FakeFlow("/v1/chat/completions", {**CHAT_BODY, "stream": True})
    roundtrip(gateway, flow, OPENAI_SSE, content_type="text/event-stream")
    assert len(runtime.events) == 2         # judged EXACTLY once, whole
    event = runtime.events[1]
    assert event["llm_protocol"] == "canonical"  # no single raw body existed
    payload = event["payload"]
    assert payload["text"] == "Hello world"
    assert payload["tool_calls"] == [
        {"id": "c1", "name": "bash", "arguments": {"command": "ls"}}]
    assert payload["model"] == "gpt-5"
    assert payload["usage"] == {"input_tokens": 7, "output_tokens": 4}
    assert payload["timing"]["completed_at"]


ANTHROPIC_SSE = (
    'event: message_start\n'
    'data: {"type": "message_start", "message": {"model": "claude-x",'
    ' "usage": {"input_tokens": 11, "cache_read_input_tokens": 5}}}\n\n'
    'event: content_block_start\n'
    'data: {"type": "content_block_start", "index": 0, "content_block": {"type": "text"}}\n\n'
    'event: content_block_delta\n'
    'data: {"type": "content_block_delta", "index": 0,'
    ' "delta": {"type": "text_delta", "text": "The answer"}}\n\n'
    'event: content_block_start\n'
    'data: {"type": "content_block_start", "index": 1,'
    ' "content_block": {"type": "tool_use", "id": "tu1", "name": "bash"}}\n\n'
    'event: content_block_delta\n'
    'data: {"type": "content_block_delta", "index": 1,'
    ' "delta": {"type": "input_json_delta", "partial_json": "{\\"command\\": \\"ls\\"}"}}\n\n'
    'event: message_delta\n'
    'data: {"type": "message_delta", "usage": {"output_tokens": 9}}\n\n'
    'event: message_stop\n'
    'data: {"type": "message_stop"}\n\n')


def test_anthropic_stream_merges_usage_halves(gateway, runtime):
    flow = FakeFlow("/v1/messages", {"model": "claude-x", "stream": True, "messages": []})
    roundtrip(gateway, flow, ANTHROPIC_SSE, content_type="text/event-stream")
    payload = runtime.events[1]["payload"]
    assert payload["text"] == "The answer"
    assert payload["tool_calls"] == [{"id": "tu1", "name": "bash",
                                      "arguments": {"command": "ls"}}]
    # message_start and message_delta halves merged, neither zeroing the other
    assert payload["usage"] == {"input_tokens": 11, "output_tokens": 9,
                                "cache_read_tokens": 5}


def test_responses_stream_uses_the_completed_raw_body(gateway, runtime):
    # The terminal frame carries the COMPLETE response object — a raw body
    # exists, so the event stays openai.responses instead of canonical.
    sse = ('data: {"type": "response.output_text.delta", "delta": "par"}\n\n'
           'data: {"type": "response.completed", "response": {"id": "resp_1",'
           ' "output": [], "usage": {"input_tokens": 2, "output_tokens": 1}}}\n\n')
    flow = FakeFlow("/v1/responses", {"model": "gpt-5", "stream": True, "input": []})
    roundtrip(gateway, flow, sse, content_type="text/event-stream")
    event = runtime.events[1]
    assert event["llm_protocol"] == "openai.responses"
    assert event["payload"]["id"] == "resp_1"
    assert event["payload"]["timing"]["started_at"]


def test_blocked_stream_never_reaches_the_client(gateway, runtime):
    runtime.verdicts.append({"event_id": "e1", "provider": "mock", "decision": "allow"})
    runtime.verdicts.append({"event_id": "e2", "provider": "mock", "decision": "block"})
    flow = FakeFlow("/v1/chat/completions", {**CHAT_BODY, "stream": True})
    roundtrip(gateway, flow, OPENAI_SSE, content_type="text/event-stream")
    # mitmproxy held the whole stream (tail = ∞): the refusal replaces it all
    assert flow.response.status_code == 403


# ── non-events ─────────────────────────────────────────────────────────────

def test_non_llm_paths_and_unreadable_bodies_pass_uncounted_vs_counted(gateway, runtime):
    other = FakeFlow("/v1/embeddings", {"input": "x"})
    run(gateway.request(other))
    assert not runtime.requests             # not an LLM call: not our traffic
    broken = FakeFlow("/v1/chat/completions", "{not json")
    run(gateway.request(broken))
    assert not runtime.requests
    assert broken.response is None
    assert gateway.counters["unreadable"] == 1  # passed unjudged, but COUNTED


def test_upstream_errors_are_not_judged(gateway, runtime):
    flow = FakeFlow("/v1/chat/completions", CHAT_BODY)
    run(gateway.request(flow))
    flow.response = FakeResponse({"error": "overloaded"}, status_code=529)
    run(gateway.response(flow))
    assert len(runtime.requests) == 1       # only the step/request half


# ── wire helpers ───────────────────────────────────────────────────────────

def test_event_json_round_trips():
    identity = dict.fromkeys(("agent_id", "agent_type", "agent_workspace",
                              "agent_user"), "")
    data = addon.event_json("step/request", "s1", identity, "openai.chat",
                            '{"messages": []}')
    event = json.loads(data)
    assert event["payload"] == {"messages": []}


def test_splice_timing_into_an_empty_object():
    out = addon.splice_timing("{}", {"started_at": "t"})
    assert json.loads(out) == {"timing": {"started_at": "t"}}


# ── optional: the real mitmproxy types ─────────────────────────────────────

def test_with_real_mitmproxy_flow(runtime):
    """Same block path through genuine mitmproxy objects; skipped offline."""
    pytest.importorskip("mitmproxy")
    from mitmproxy.test import tflow, tutils

    gw = OGRGateway(ogr_url=runtime.url, ogr_api_key="ogr_test", **FIVE_TUPLE)
    runtime.verdicts.append({"event_id": "e", "provider": "mock", "decision": "block"})
    flow = tflow.tflow(req=tutils.treq(
        method=b"POST", path=b"/v1/chat/completions",
        content=json.dumps(CHAT_BODY).encode()))
    run(gw.request(flow))
    assert flow.response.status_code == 403
