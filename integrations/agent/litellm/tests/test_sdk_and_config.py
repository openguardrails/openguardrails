"""The SDK seat (observe-only logging callbacks) and configuration.

``litellm.callbacks = [OpenGuardrails()]`` fires litellm's LOGGING events,
whose exceptions litellm swallows — so this seat sends both halves of every
step but cannot block; a would-be block is logged and counted instead.
"""

import asyncio
from datetime import datetime, timezone

from openguardrails_litellm import OpenGuardrails

run = asyncio.run

START = datetime(2026, 8, 15, 9, 30, 1, tzinfo=timezone.utc)
END = datetime(2026, 8, 15, 9, 30, 2, 100000, tzinfo=timezone.utc)


def sdk_kwargs(call_id="sdk-call-1"):
    """The model_call_details litellm passes its logging callbacks."""
    return {
        "call_type": "completion",
        "litellm_params": {"litellm_call_id": call_id, "metadata": {}},
        "additional_args": {
            "complete_input_dict": {
                "model": "gpt-4o",
                "messages": [{"role": "user", "content": "hi"}],
                "api_key": "sk-provider-secret",
            },
        },
    }


def sdk_response():
    return {
        "id": "chatcmpl-2", "object": "chat.completion", "model": "gpt-4o",
        "choices": [{"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": "hello"}}],
        "usage": {"prompt_tokens": 3, "completion_tokens": 1},
    }


# ── SDK observe flow ───────────────────────────────────────────────────────


def test_sdk_callbacks_send_both_halves_same_step_id(runtime, make_guard):
    guard = make_guard()
    kwargs = sdk_kwargs()
    guard.log_pre_api_call("gpt-4o", kwargs["additional_args"]
                           ["complete_input_dict"]["messages"], kwargs)
    guard.log_success_event(kwargs, sdk_response(), START, END)

    events = runtime.events
    assert [e["kind"] for e in events] == ["step/request", "step/response"]
    assert events[0]["step_id"] == events[1]["step_id"] == "sdk-call-1"
    # the request payload is litellm's complete_input_dict, minus credentials
    assert "api_key" not in events[0]["payload"]
    assert events[0]["payload"]["messages"][0]["content"] == "hi"
    # timing from the wall clocks litellm hands over
    timing = events[1]["payload"]["timing"]
    assert timing["started_at"] == "2026-08-15T09:30:01.000Z"
    assert timing["completed_at"] == "2026-08-15T09:30:02.100Z"


def test_async_sdk_callbacks_work_too(runtime, make_guard):
    guard = make_guard()
    kwargs = sdk_kwargs("sdk-async-1")
    run(guard.async_log_pre_api_call("gpt-4o", [], kwargs))
    run(guard.async_log_success_event(kwargs, sdk_response(), START, END))
    assert [e["step_id"] for e in runtime.events] == ["sdk-async-1"] * 2


def test_sdk_block_is_observed_not_raised(runtime, make_guard):
    """litellm swallows logging-callback exceptions: the honest ceiling of
    the SDK seat is to count the block, loudly, and let the call proceed."""
    runtime.block()
    guard = make_guard()
    kwargs = sdk_kwargs("sdk-block-1")
    guard.log_pre_api_call("gpt-4o", [], kwargs)  # must NOT raise
    guard.log_success_event(kwargs, sdk_response(), START, END)  # must NOT raise
    assert guard.counters["blocks"] == 2


def test_sdk_streamed_call_prefers_the_complete_response(runtime, make_guard):
    guard = make_guard()
    kwargs = sdk_kwargs("sdk-stream-1")
    kwargs["complete_streaming_response"] = sdk_response()
    last_chunk = {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}
    guard.log_success_event(kwargs, last_chunk, START, END)
    payload = runtime.events[0]["payload"]
    assert payload["choices"][0]["message"]["content"] == "hello"


def test_proxy_claimed_steps_are_not_double_sent_by_sdk_logs(runtime,
                                                             make_guard):
    """In the proxy, BOTH surfaces fire for one call; the enforcing hooks
    claim the step_id first and the logging events stand down."""
    guard = make_guard()
    data = {"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}],
            "litellm_call_id": "dup-1"}
    run(guard.async_pre_call_hook(None, None, data, "completion"))
    kwargs = sdk_kwargs("dup-1")
    guard.log_pre_api_call("gpt-4o", [], kwargs)  # stands down
    guard.log_success_event(kwargs, sdk_response(), START, END)  # stands down
    run(guard.async_post_call_success_hook(data, None, sdk_response()))
    assert [e["kind"] for e in runtime.events] == ["step/request",
                                                   "step/response"]


# ── configuration ──────────────────────────────────────────────────────────


def test_env_fallbacks_fill_the_five_tuple(runtime, monkeypatch):
    monkeypatch.setenv("OGR_RUNTIME_URL", runtime.url)
    monkeypatch.setenv("OGR_API_KEY", "ogr_env_key")
    monkeypatch.setenv("OGR_AGENT_ID", "invoice-bot")
    monkeypatch.setenv("OGR_AGENT_TYPE", "litellm-proxy")
    monkeypatch.setenv("OGR_AGENT_WORKSPACE", "finance-agents")
    monkeypatch.setenv("OGR_AGENT_USER", "u-8232")
    monkeypatch.setenv("OGR_FAIL_MODE", "closed")
    monkeypatch.setenv("OGR_TIMEOUT", "2.5")
    guard = OpenGuardrails()
    assert guard.identity == {
        "agent_id": "invoice-bot", "agent_type": "litellm-proxy",
        "agent_workspace": "finance-agents",
        "agent_user": "u-8232",
    }
    assert guard.fail_mode == "closed"
    assert guard.wire.timeout == 2.5
    assert guard.wire.api_key == "ogr_env_key"

    data = {"model": "gpt-4o", "messages": [], "litellm_call_id": "env-1"}
    run(guard.async_pre_call_hook(None, None, data, "completion"))
    event = runtime.events[0]
    assert event["agent_id"] == "invoice-bot"
    assert event["agent_user"] == "u-8232"
    assert runtime.requests[0]["auth"] == "Bearer ogr_env_key"


def test_constructor_args_override_env(monkeypatch):
    monkeypatch.setenv("OGR_AGENT_ID", "from-env")
    monkeypatch.setenv("OGR_FAIL_MODE", "closed")
    guard = OpenGuardrails(agent_id="from-arg", fail_mode="open")
    assert guard.identity["agent_id"] == "from-arg"
    assert guard.fail_mode == "open"


def test_invalid_fail_mode_is_rejected():
    import pytest

    with pytest.raises(ValueError):
        OpenGuardrails(fail_mode="ajar")
