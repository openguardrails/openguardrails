"""Offline tests for the mitmproxy gateway addon — no runtime, no upstream LLM.

The OGR client is stubbed to return a chosen Verdict, so we assert the addon
short-circuits the flow correctly for each wire protocol.
"""
import asyncio
import json

import pytest
from mitmproxy.test import tflow, tutils

from ogr_mitmproxy import protocols
from ogr_mitmproxy.addon import OGRGateway


def _req_flow(path: str, body: dict):
    # our routing depends only on the request path; scheme/host are irrelevant.
    return tflow.tflow(
        req=tutils.treq(method=b"POST", path=path.encode(),
                        content=json.dumps(body).encode()))


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ── protocol parsing ──────────────────────────────────────────────────────
def test_match():
    assert protocols.match("/v1/chat/completions") == "openai.chat"
    assert protocols.match("/v1/messages?beta=true") == "anthropic.messages"
    assert protocols.match("/v1/embeddings") is None


def test_parse_openai_request():
    body = {"model": "gpt-4o", "messages": [
        {"role": "system", "content": "be nice"},
        {"role": "user", "content": "hello"},
        {"role": "user", "content": "how do I hurt someone"}]}
    p = protocols.parse_request("openai.chat", body)
    assert p["latest_user"] == "how do I hurt someone"


def test_parse_anthropic_request_and_response():
    body = {"model": "claude", "system": "sys",
            "messages": [{"role": "user", "content": [{"type": "text", "text": "hi there"}]}]}
    assert protocols.parse_request("anthropic.messages", body)["latest_user"] == "hi there"
    resp = {"content": [{"type": "text", "text": "the answer"}]}
    assert protocols.parse_response("anthropic.messages", resp) == "the answer"


def test_parse_openai_response():
    resp = {"choices": [{"message": {"role": "assistant", "content": "done"}}]}
    assert protocols.parse_response("openai.chat", resp) == "done"


def test_codex_ws_parse():
    # real shape captured from codex (ChatGPT backend) response.create frame
    assert protocols.is_codex_ws("/backend-api/codex/responses")
    assert not protocols.is_codex_ws("/v1/chat/completions")
    frame = json.dumps({"type": "response.create", "model": "gpt-5.6-sol", "input": [
        {"type": "additional_tools", "role": "developer", "tools": []},
        {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "env ctx"}]},
        {"type": "message", "role": "user",
         "content": [{"type": "input_text", "text": "how do I hurt someone"}],
         "internal_chat_message_metadata_passthrough": {"turn_id": "t-9"}}]})
    got = protocols.parse_codex_ws_user(frame)
    assert got == ("how do I hurt someone", "t-9")
    # a frame with no user turn (history/tools only) -> None
    assert protocols.parse_codex_ws_user(json.dumps(
        {"type": "response.create", "input": [{"role": "developer", "type": "message"}]})) is None
    # non-response.create frame -> None
    assert protocols.parse_codex_ws_user(json.dumps({"type": "response.output_text.delta"})) is None


# ── enforcement ────────────────────────────────────────────────────────────
@pytest.mark.parametrize("path,proto", [
    ("/v1/chat/completions", "openai.chat"),
    ("/v1/messages", "anthropic.messages"),
])
def test_block_request(monkeypatch, path, proto):
    gw = OGRGateway()

    async def fake_eval(event):
        assert event["kind"] == "user_input"
        assert event["llm_protocol"] == proto
        return {"decision": "block", "guard_id": "gw-1",
                "reasons": ["safety.self_harm"], "categories": []}

    monkeypatch.setattr(gw, "_evaluate", fake_eval)
    flow = _req_flow(path, {"model": "m", "messages": [{"role": "user", "content": "kill myself"}]})
    _run(gw.request(flow))
    assert flow.response is not None
    assert flow.response.status_code == 403
    assert b"OpenGuardrails" in flow.response.content


def test_allow_request_passes_through(monkeypatch):
    gw = OGRGateway()
    monkeypatch.setattr(gw, "_evaluate",
                        lambda e: _wrap({"decision": "allow"}))
    flow = _req_flow("/v1/chat/completions",
                     {"model": "m", "messages": [{"role": "user", "content": "hello"}]})
    _run(gw.request(flow))
    assert flow.response is None  # not short-circuited → forwarded upstream


def test_non_llm_flow_ignored(monkeypatch):
    gw = OGRGateway()
    called = {"n": 0}

    async def spy(event):
        called["n"] += 1
        return {"decision": "allow"}

    monkeypatch.setattr(gw, "_evaluate", spy)
    flow = _req_flow("/v1/embeddings", {"input": "x"})
    _run(gw.request(flow))
    assert flow.response is None and called["n"] == 0


def test_require_approval_returns_409(monkeypatch):
    gw = OGRGateway()
    monkeypatch.setattr(gw, "_evaluate",
                        lambda e: _wrap({"decision": "require_approval", "reasons": ["needs review"]}))
    flow = _req_flow("/v1/chat/completions",
                     {"model": "m", "messages": [{"role": "user", "content": "deploy prod"}]})
    _run(gw.request(flow))
    assert flow.response is not None and flow.response.status_code == 409


def test_fail_closed_blocks_on_pdp_error(monkeypatch):
    gw = OGRGateway()
    gw.fail_closed = True
    monkeypatch.setattr(gw, "_evaluate", lambda e: _wrap(None))
    flow = _req_flow("/v1/chat/completions",
                     {"model": "m", "messages": [{"role": "user", "content": "hi"}]})
    _run(gw.request(flow))
    assert flow.response is not None and flow.response.status_code == 403


def _wrap(value):
    async def _c(_event):
        return value
    return _c(None)
