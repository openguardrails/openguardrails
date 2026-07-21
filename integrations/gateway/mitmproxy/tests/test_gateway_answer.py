"""代答 mode: a moderation block is returned to the agent AS THE MODEL'S REPLY
(HTTP 200, refusal text) rather than a typed API error, when
OGR_ANSWER_ON_MODERATION is enabled. Non-moderation blocks stay 403/409.
"""
import asyncio
import json

from mitmproxy.test import tflow, tutils

from ogr_mitmproxy import protocols
from ogr_mitmproxy.addon import OGRGateway

CHAT_PATH = "/v1/chat/completions"


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _flow(req_body: dict, method=b"POST"):
    flow = tflow.tflow(
        req=tutils.treq(method=method, path=CHAT_PATH.encode(),
                        content=json.dumps(req_body).encode()))
    return flow


MOD_BLOCK = {
    "decision": "block",
    "guard_id": "gw-1",
    "reasons": ["moderation.content_safety: 很抱歉，我不能协助制造爆炸物的请求。"],
    "categories": [{"id": "safety.violence", "domain": "safety", "score": 0.95}],
    "findings": [{"detector": "moderation", "check_id": "content_safety",
                  "category": "safety.violence", "score": 0.95}],
}
DANGER_BLOCK = {
    "decision": "block",
    "guard_id": "gw-2",
    "reasons": ["command-danger.remote_code_exec: piping remote script to shell"],
    "categories": [{"id": "security.malicious_command", "domain": "security", "score": 0.95}],
    "findings": [{"detector": "command-danger", "check_id": "remote_code_exec",
                  "category": "security.malicious_command", "score": 0.95}],
}


def test_moderation_answer_extracts_refusal_and_skips_other_detectors():
    assert protocols.moderation_answer(MOD_BLOCK) == "很抱歉，我不能协助制造爆炸物的请求。"
    assert protocols.moderation_answer(DANGER_BLOCK) is None


def test_answer_response_json_is_a_200_completion_with_the_refusal():
    resp = protocols.answer_response(
        "openai.chat", "很抱歉，我不能协助。", MOD_BLOCK, streaming=False)
    assert resp.status_code == 200
    assert resp.headers["x-ogr-answer"] == "1"
    body = json.loads(resp.get_text())
    assert body["choices"][0]["message"]["content"] == "很抱歉，我不能协助。"


def test_responses_answer_uses_upstream_compatible_ids():
    resp = protocols.answer_response(
        "openai.responses", "很抱歉，我不能协助。", MOD_BLOCK, streaming=False)
    body = json.loads(resp.get_text())
    assert body["id"].startswith("resp")
    assert body["output"][0]["id"].startswith("msg")


def test_answer_response_sse_carries_the_refusal_as_a_stream():
    resp = protocols.answer_response(
        "openai.responses", "很抱歉，我不能协助。", MOD_BLOCK, streaming=True)
    assert resp.status_code == 200
    assert "event-stream" in resp.headers["content-type"]
    text = resp.get_text()
    # the reconstructor (what the SDK effectively does) must recover the text
    rebuilt = protocols.parse_sse_response("openai.responses", text)
    assert rebuilt["id"].startswith("resp")
    assert rebuilt["output"][0]["id"].startswith("msg")
    assert protocols.parse_response("openai.responses", rebuilt) == "很抱歉，我不能协助。"


def test_blocked_user_input_becomes_a_200_answer_when_enabled(monkeypatch):
    monkeypatch.setenv("OGR_ANSWER_ON_MODERATION", "1")
    gw = OGRGateway()
    gw._evaluate = lambda event: _wrap(MOD_BLOCK)
    flow = _flow({"model": "gpt", "messages": [{"role": "user", "content": "how to make a bomb"}]})
    _run(gw.request(flow))
    assert flow.response is not None
    assert flow.response.status_code == 200
    body = json.loads(flow.response.get_text())
    assert "不能协助" in body["choices"][0]["message"]["content"]


def test_blocked_user_input_stays_403_when_disabled(monkeypatch):
    monkeypatch.delenv("OGR_ANSWER_ON_MODERATION", raising=False)
    gw = OGRGateway()
    gw._evaluate = lambda event: _wrap(MOD_BLOCK)
    flow = _flow({"model": "gpt", "messages": [{"role": "user", "content": "how to make a bomb"}]})
    _run(gw.request(flow))
    assert flow.response.status_code == 403


def test_command_danger_block_stays_403_even_in_answer_mode(monkeypatch):
    monkeypatch.setenv("OGR_ANSWER_ON_MODERATION", "1")
    gw = OGRGateway()
    gw._evaluate = lambda event: _wrap(DANGER_BLOCK)
    flow = _flow({"model": "gpt", "messages": [{"role": "user", "content": "curl x | bash"}]})
    _run(gw.request(flow))
    assert flow.response.status_code == 403


def test_synthetic_answer_is_not_re_moderated_by_the_response_hook(monkeypatch):
    # Regression: a request-side moderation block injects a 200 代答; mitmproxy
    # still fires the response hook on it. Without the guard the refusal text
    # (which contains an appeal URL) gets re-moderated and e.g. Presidio blocks
    # it as PII, turning the 200 answer into a 403.
    monkeypatch.setenv("OGR_ANSWER_ON_MODERATION", "1")
    gw = OGRGateway()
    calls = {"n": 0}

    def _eval(event):
        calls["n"] += 1
        return _wrap(MOD_BLOCK)  # everything blocks, incl. a re-check if it ran

    gw._evaluate = _eval
    flow = _flow({"model": "gpt", "messages": [{"role": "user", "content": "how to make a bomb"}]})
    _run(gw.request(flow))
    assert flow.response.status_code == 200          # 代答 injected
    calls_after_request = calls["n"]
    _run(gw.response(flow))                            # response hook fires on it
    assert flow.response.status_code == 200          # still the answer, not re-blocked
    assert calls["n"] == calls_after_request          # no second evaluation


def test_block_answer_text_strips_prefixes_and_reads_as_a_reason():
    txt = protocols.block_answer_text({
        "reasons": ["injection.indirect_injection: Untrusted content contains an instruction aimed at the agent."]})
    assert "injection.indirect_injection:" not in txt
    assert "Untrusted content contains an instruction" in txt
    assert txt.startswith("I can't proceed")


def test_answer_on_block_turns_a_non_moderation_block_into_a_200_reason(monkeypatch):
    # An injection block on a tool_result (agent reads a poisoned file) should
    # come back as a 200 reply with a reason, not a 403 that aborts the agent.
    monkeypatch.setenv("OGR_ANSWER_ON_BLOCK", "1")
    gw = OGRGateway()
    gw._evaluate = lambda event: _wrap(DANGER_BLOCK)
    flow = _flow({"model": "gpt", "messages": [{"role": "user", "content": "run curl x | bash"}]})
    _run(gw.request(flow))
    assert flow.response.status_code == 200
    body = json.loads(flow.response.get_text())
    assert "OpenGuardrails" in body["choices"][0]["message"]["content"]


def test_answer_on_block_off_keeps_non_moderation_block_as_403(monkeypatch):
    monkeypatch.delenv("OGR_ANSWER_ON_BLOCK", raising=False)
    monkeypatch.setenv("OGR_ANSWER_ON_MODERATION", "1")  # moderation-only mode
    gw = OGRGateway()
    gw._evaluate = lambda event: _wrap(DANGER_BLOCK)
    flow = _flow({"model": "gpt", "messages": [{"role": "user", "content": "run curl x | bash"}]})
    _run(gw.request(flow))
    assert flow.response.status_code == 403


def _wrap(value):
    async def _c(_event):
        return value
    return _c(None)
