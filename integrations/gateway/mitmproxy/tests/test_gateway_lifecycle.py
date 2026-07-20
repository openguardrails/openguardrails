"""Authoritative Agent→Session→Run→Turn telemetry over normal LLM HTTP."""
import asyncio
import json

from mitmproxy.http import Headers
from mitmproxy.test import tflow, tutils

from ogr_mitmproxy.addon import OGRGateway


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _flow(body: dict, *, turn: int = 0, response=None, response_headers=None):
    request = tutils.treq(
        method=b"POST",
        path=b"/v1/chat/completions",
        content=json.dumps(body).encode(),
    )
    request.headers["x-ogr-session"] = "hermes-session"
    request.headers["x-ogr-run"] = "hermes-user-turn"
    request.headers["x-ogr-turn"] = str(turn)
    flow = tflow.tflow(req=request)
    if response is not None:
        payload = response if isinstance(response, bytes) else json.dumps(response).encode()
        flow.response = tutils.tresp(
            status_code=200,
            content=payload,
            headers=Headers(
                response_headers or [(b"content-type", b"application/json")]
            ),
        )
    return flow


def test_request_emits_user_once_and_full_model_input_each_turn(monkeypatch):
    gateway = OGRGateway()
    events = []

    async def allow(event):
        events.append(event)
        return {"decision": "allow", "reasons": [], "categories": []}

    monkeypatch.setattr(gateway, "_evaluate", allow)
    first = _flow({
        "model": "gpt",
        "messages": [
            {"role": "system", "content": "system prompt"},
            {"role": "developer", "content": "developer prompt"},
            {"role": "user", "content": "hi"},
        ],
    })
    _run(gateway.request(first))

    second = _flow({
        "model": "gpt",
        "messages": [
            {"role": "system", "content": "system prompt"},
            {"role": "developer", "content": "developer prompt"},
            {"role": "user", "content": "hi"},
            {"role": "assistant", "tool_calls": [{
                "id": "call-1",
                "type": "function",
                "function": {"name": "search", "arguments": "{\"q\":\"route\"}"},
            }]},
            {"role": "tool", "tool_call_id": "call-1", "content": "route result"},
        ],
    }, turn=1)
    _run(gateway.request(second))

    assert [event["kind"] for event in events] == [
        "user_input",
        "model_input",
        "tool_result",
        "model_input",
    ]
    assert all(event["session_id"] == "hermes-session" for event in events)
    assert all(event["run_id"] == "hermes-user-turn" for event in events)
    # The tool_result rides in the turn-1 request but belongs to the Turn of
    # the Action that produced it (turn 0).
    assert [event["turn"] for event in events] == [0, 0, 0, 1]
    assert events[1]["payload"]["messages"][1] == {
        "role": "developer",
        "content": "developer prompt",
    }
    assert events[2]["payload"]["result"] == "route result"


def test_response_emits_action_and_complete_assistant_payload(monkeypatch):
    gateway = OGRGateway()
    events = []

    async def allow(event):
        events.append(event)
        return {"decision": "allow", "reasons": [], "categories": []}

    monkeypatch.setattr(gateway, "_evaluate", allow)
    flow = _flow(
        {"model": "gpt", "messages": [{"role": "user", "content": "find route"}]},
        turn=2,
        response={
            "model": "gpt",
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": "I will check traffic.",
                    "tool_calls": [{
                        "id": "call-2",
                        "type": "function",
                        "function": {
                            "name": "traffic.current",
                            "arguments": "{\"road\":\"101\"}",
                        },
                    }],
                },
            }],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5},
        },
    )
    _run(gateway.request(flow))
    events.clear()
    _run(gateway.response(flow))

    assert [event["kind"] for event in events] == ["tool_call", "model_output"]
    assert events[0]["payload"] == {
        "name": "traffic.current",
        "arguments": {"road": "101"},
        "call_id": "call-2",
    }
    assert events[0]["turn"] == 2
    assert events[1]["payload"]["content"] == "I will check traffic."
    assert events[1]["payload"]["tool_calls"][0]["id"] == "call-2"


def test_streaming_chat_reconstructs_tool_action(monkeypatch):
    gateway = OGRGateway()
    events = []

    async def allow(event):
        events.append(event)
        return {"decision": "allow", "reasons": [], "categories": []}

    monkeypatch.setattr(gateway, "_evaluate", allow)
    sse = (
        'data: {"model":"gpt","choices":[{"delta":{"role":"assistant"}}]}\n\n'
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-3",'
        '"type":"function","function":{"name":"maps.","arguments":"{\\\"q\\\":"}}]}}]}\n\n'
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,'
        '"function":{"name":"search","arguments":"\\\"SFO\\\"}"}}]},'
        '"finish_reason":"tool_calls"}]}\n\n'
        'data: [DONE]\n\n'
    )
    flow = _flow(
        {"model": "gpt", "messages": [{"role": "user", "content": "route"}]},
        turn=3,
        response=sse.encode(),
        response_headers=[(b"content-type", b"text/event-stream")],
    )
    _run(gateway.request(flow))
    events.clear()
    _run(gateway.response(flow))

    action = next(event for event in events if event["kind"] == "tool_call")
    assert action["payload"]["name"] == "maps.search"
    assert action["payload"]["arguments"] == {"q": "SFO"}
    assert action["turn"] == 3


def test_tool_call_and_later_result_share_one_action_guard(monkeypatch):
    gateway = OGRGateway()
    events = []

    async def allow(event):
        events.append(event)
        return {"decision": "allow", "reasons": [], "categories": []}

    monkeypatch.setattr(gateway, "_evaluate", allow)
    call_flow = _flow(
        {"messages": [{"role": "user", "content": "search"}]},
        response={
            "choices": [{
                "message": {
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call-correlated",
                        "type": "function",
                        "function": {"name": "search", "arguments": "{}"},
                    }],
                },
                "finish_reason": "tool_calls",
            }],
        },
    )
    _run(gateway.request(call_flow))
    _run(gateway.response(call_flow))

    result_flow = _flow({
        "messages": [
            {"role": "user", "content": "search"},
            {"role": "tool", "tool_call_id": "call-correlated", "content": "done"},
        ],
    }, turn=1)
    _run(gateway.request(result_flow))

    tool_call = next(event for event in events if event["kind"] == "tool_call")
    tool_result = next(event for event in events if event["kind"] == "tool_result")
    assert tool_call["guard_id"] == tool_result["guard_id"]


def _untagged_hermes_flow(body, *, response):
    request = tutils.treq(
        method=b"POST",
        path=b"/v1/chat/completions",
        content=json.dumps(body).encode(),
    )
    flow = tflow.tflow(req=request)
    flow.response = tutils.tresp(
        status_code=200,
        content=json.dumps(response).encode(),
        headers=Headers([(b"content-type", b"application/json")]),
    )
    return flow


def test_hermes_fallback_keeps_greeting_one_run_one_turn_and_skips_title(monkeypatch):
    gateway = OGRGateway()
    events = []

    async def allow(event):
        events.append(event)
        return {"decision": "allow", "reasons": [], "categories": []}

    monkeypatch.setattr(gateway, "_evaluate", allow)
    main = _untagged_hermes_flow(
        {
            "session_id": "20260719_hermes_real",
            "messages": [{"role": "user", "content": "你好呀"}],
            "tools": [{"type": "function", "function": {"name": "search"}}],
        },
        response={
            "choices": [{
                "message": {"role": "assistant", "content": "你好！"},
                "finish_reason": "stop",
            }],
        },
    )
    _run(gateway.request(main))
    _run(gateway.response(main))

    title = _untagged_hermes_flow(
        {"messages": [{
            "role": "user",
            "content": "User: 你好呀\n\nAssistant: 你好！",
        }]},
        response={
            "choices": [{
                "message": {"role": "assistant", "content": "Greeting"},
                "finish_reason": "stop",
            }],
        },
    )
    _run(gateway.request(title))
    _run(gateway.response(title))

    assert [event["kind"] for event in events] == [
        "user_input", "model_input", "model_output",
    ]
    assert len({event["session_id"] for event in events}) == 1
    assert {event["session_id"] for event in events} == {"20260719_hermes_real"}
    assert len({event["run_id"] for event in events}) == 1
    assert {event["turn"] for event in events} == {0}
    assert title.metadata["ogr_skip"] is True


def test_hermes_fallback_groups_tool_loop_as_turns_and_actions(monkeypatch):
    gateway = OGRGateway()
    events = []

    async def allow(event):
        events.append(event)
        return {"decision": "allow", "reasons": [], "categories": []}

    monkeypatch.setattr(gateway, "_evaluate", allow)
    first = _untagged_hermes_flow(
        {
            "session_id": "20260719_search_session",
            "messages": [{"role": "user", "content": "搜索一下spacex最新的消息"}],
            "tools": [{"type": "function", "function": {"name": "search"}}],
        },
        response={
            "choices": [{
                "message": {
                    "role": "assistant",
                    "tool_calls": [{
                        "id": "call-search",
                        "type": "function",
                        "function": {
                            "name": "search",
                            "arguments": "{\"q\":\"SpaceX\"}",
                        },
                    }],
                },
                "finish_reason": "tool_calls",
            }],
        },
    )
    _run(gateway.request(first))
    _run(gateway.response(first))

    second = _untagged_hermes_flow(
        {
            "session_id": "20260719_search_session",
            "messages": [
                {"role": "user", "content": "搜索一下spacex最新的消息"},
                {"role": "assistant", "tool_calls": [{
                    "id": "call-search",
                    "type": "function",
                    "function": {"name": "search", "arguments": "{\"q\":\"SpaceX\"}"},
                }]},
                {"role": "tool", "tool_call_id": "call-search", "content": "news"},
            ],
            "tools": [{"type": "function", "function": {"name": "search"}}],
        },
        response={
            "choices": [{
                "message": {"role": "assistant", "content": "以下是最新消息"},
                "finish_reason": "stop",
            }],
        },
    )
    _run(gateway.request(second))
    _run(gateway.response(second))

    assert [event["kind"] for event in events] == [
        "user_input", "model_input", "tool_call", "model_output",
        "tool_result", "model_input", "model_output",
    ]
    assert len({event["session_id"] for event in events}) == 1
    assert len({event["run_id"] for event in events}) == 1
    # tool_result is attributed back to turn 0 — the Turn whose Action
    # produced it — even though it rides in the turn-1 request.
    assert [event["turn"] for event in events] == [0, 0, 0, 0, 0, 1, 1]
    assert sum(event["kind"] == "tool_call" for event in events) == 1


def test_hermes_ordinary_session_field_separates_new_session(monkeypatch):
    gateway = OGRGateway()
    events = []

    async def allow(event):
        events.append(event)
        return {"decision": "allow", "reasons": [], "categories": []}

    monkeypatch.setattr(gateway, "_evaluate", allow)
    for session_id in ("hermes-session-old", "hermes-session-new"):
        flow = _untagged_hermes_flow(
            {
                "session_id": session_id,
                "messages": [{"role": "user", "content": "same prompt"}],
                "tools": [{"type": "function", "function": {"name": "search"}}],
            },
            response={
                "choices": [{
                    "message": {"role": "assistant", "content": "done"},
                    "finish_reason": "stop",
                }],
            },
        )
        _run(gateway.request(flow))
        _run(gateway.response(flow))

    user_events = [event for event in events if event["kind"] == "user_input"]
    assert [event["session_id"] for event in user_events] == [
        "hermes-session-old", "hermes-session-new",
    ]
    assert len({event["run_id"] for event in user_events}) == 2


def test_fresh_conversation_with_same_opening_prompt_gets_new_session(monkeypatch):
    """A restarted conversation reusing an identical first prompt must not be
    merged into the older inferred Session once that Session has grown past it."""
    gateway = OGRGateway()
    events = []

    async def allow(event):
        events.append(event)
        return {"decision": "allow", "reasons": [], "categories": []}

    monkeypatch.setattr(gateway, "_evaluate", allow)

    def convo(messages):
        return _untagged_hermes_flow(
            {"messages": messages,
             "tools": [{"type": "function", "function": {"name": "search"}}]},
            response={"choices": [{
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop",
            }]},
        )

    a1 = convo([{"role": "user", "content": "same opening"}])
    _run(gateway.request(a1))
    _run(gateway.response(a1))
    a2 = convo([
        {"role": "user", "content": "same opening"},
        {"role": "assistant", "content": "ok"},
        {"role": "user", "content": "second task"},
    ])
    _run(gateway.request(a2))
    _run(gateway.response(a2))

    # Conversation B: brand-new history that happens to reuse the opening.
    b1 = convo([{"role": "user", "content": "same opening"}])
    _run(gateway.request(b1))
    _run(gateway.response(b1))

    user_events = [event for event in events if event["kind"] == "user_input"]
    assert len(user_events) == 3
    session_a = user_events[0]["session_id"]
    assert user_events[1]["session_id"] == session_a
    assert user_events[2]["session_id"] != session_a


def test_subject_is_empty_without_operator_override(monkeypatch):
    """Agent identity is derived by the runtime from the system prompt; the
    gateway must not stamp a default agent id."""
    monkeypatch.delenv("OGR_AGENT_ID", raising=False)
    monkeypatch.delenv("OGR_AGENT_TYPE", raising=False)
    gateway = OGRGateway()
    assert gateway._subject() == {}
    monkeypatch.setenv("OGR_AGENT_ID", "forced-agent")
    assert OGRGateway()._subject() == {"agent_id": "forced-agent"}


def test_retried_provider_call_reuses_the_same_turn(monkeypatch):
    """An agent resending an identical request after an upstream 403/429 is
    the same model roundtrip — it must not advance the Turn counter."""
    gateway = OGRGateway()
    events = []

    async def allow(event):
        events.append(event)
        return {"decision": "allow", "reasons": [], "categories": []}

    monkeypatch.setattr(gateway, "_evaluate", allow)
    body = {
        "session_id": "retry-session",
        "messages": [{"role": "user", "content": "do the thing"}],
        "tools": [{"type": "function", "function": {"name": "search"}}],
    }
    ok = {"choices": [{
        "message": {"role": "assistant", "content": "done"},
        "finish_reason": "stop",
    }]}

    first = _untagged_hermes_flow(body, response=ok)
    _run(gateway.request(first))
    # Upstream rejected it; the agent resends the very same body.
    retry = _untagged_hermes_flow(body, response=ok)
    _run(gateway.request(retry))

    model_inputs = [e for e in events if e["kind"] == "model_input"]
    assert len(model_inputs) == 2
    assert [e["turn"] for e in model_inputs] == [0, 0]
    assert len({e["run_id"] for e in model_inputs}) == 1


def test_fail_open_keeps_observing_after_a_pdp_failure(monkeypatch):
    """With fail-open, an unreachable PDP must not silently swallow the rest
    of the request's telemetry."""
    gateway = OGRGateway()
    monkeypatch.setattr(gateway, "fail_closed", False)
    events = []
    calls = {"n": 0}

    async def flaky(event):
        events.append(event)
        calls["n"] += 1
        # Fail exactly on the tool_result evaluation.
        if event["kind"] == "tool_result":
            return None
        return {"decision": "allow", "reasons": [], "categories": []}

    monkeypatch.setattr(gateway, "_evaluate", flaky)
    flow = _flow({
        "messages": [
            {"role": "user", "content": "hi"},
            {"role": "tool", "tool_call_id": "call-x", "content": "result"},
        ],
    }, turn=1)
    _run(gateway.request(flow))

    kinds = [event["kind"] for event in events]
    assert "tool_result" in kinds
    assert "model_input" in kinds, "model_input must survive a PDP failure"
    assert flow.response is None
