"""The proxy seat: the two enforcing hooks, one v0.8 recipe.

Every event the mock runtime accepts has already passed STRICT validation
(exactly the ten GuardEvent fields — see conftest.validate_event; the
runtime fixture fails the test on any schema error at teardown).
"""

import asyncio

import pytest

from openguardrails_litellm import INTEGRATION, OpenGuardrails, OpenGuardrailsBlockedError

run = asyncio.run


def request_data(call_id="call-abc123"):
    """What litellm's proxy hands async_pre_call_hook: the client body plus
    litellm bookkeeping and secrets that must NOT reach the wire."""
    data = {
        "model": "gpt-4o",
        "messages": [{"role": "user", "content": "please email bob@example.com"}],
        "metadata": {"user_api_key": "hashed-key"},
        "proxy_server_request": {"headers": {"authorization": "Bearer sk-client"}},
        "api_key": "sk-provider-secret",
    }
    if call_id is not None:
        data["litellm_call_id"] = call_id
    return data


def response_body(content="Sure, emailing bob@example.com now."):
    return {
        "id": "chatcmpl-1",
        "object": "chat.completion",
        "model": "gpt-4o",
        "choices": [
            {"index": 0, "finish_reason": "stop",
             "message": {"role": "assistant", "content": content}},
        ],
        "usage": {"prompt_tokens": 10, "completion_tokens": 8},
    }


# ── allow flow ─────────────────────────────────────────────────────────────


def test_allow_flow_sends_both_halves(runtime, make_guard):
    guard = make_guard()
    data = request_data()
    returned = run(guard.async_pre_call_hook(None, None, data, "completion"))
    assert returned is data

    response = response_body()
    out = run(guard.async_post_call_success_hook(data, None, response))
    assert out is response

    events = runtime.events
    assert [e["kind"] for e in events] == ["step/request", "step/response"]

    # step_id: litellm_call_id, same value on both halves of the step
    assert events[0]["step_id"] == events[1]["step_id"] == "call-abc123"

    # both went out with the org key
    assert all(r["auth"] == "Bearer ogr_test_key" for r in runtime.requests)

    # llm_protocol: litellm normalizes to the OpenAI chat shape
    assert all(e["llm_protocol"] == "openai.chat" for e in events)

    # the request payload is the provider body — bookkeeping and secrets out
    payload = events[0]["payload"]
    assert payload["model"] == "gpt-4o"
    assert payload["messages"][0]["content"] == "please email bob@example.com"
    for leaked in ("litellm_call_id", "metadata", "proxy_server_request",
                   "api_key"):
        assert leaked not in payload

    # the response payload is the ModelResponse, raw, plus timing
    assert events[1]["payload"]["choices"] == response["choices"]
    timing = events[1]["payload"]["timing"]
    assert set(timing) >= {"started_at", "completed_at"}
    # ... and timing was added to the EVENT, not injected into the client copy
    assert "timing" not in response


def test_exactly_the_required_fields_plus_integration_and_empty_five_tuple_defaults(runtime):
    guard = OpenGuardrails(runtime_url=runtime.url, api_key="ogr_test_key")
    run(guard.async_pre_call_hook(None, None, request_data(), "acompletion"))
    event = runtime.events[0]
    # strict shape is asserted by the mock on every request; spot-check here.
    # `integration` is the ONE optional field, restored to the event on
    # 2026-08-17: the heartbeat's record is keyed on the integration NAME, so it
    # reports whichever replica beat last and cannot say which build produced a
    # given piece of traffic.
    assert set(event) == {
        "kind", "step_id", "agent_id", "agent_type", "agent_workspace",
        "agent_user", "llm_protocol", "payload",
        "integration",
    }
    # The SAME constant the heartbeat sends — two literals would drift.
    assert event["integration"] == INTEGRATION
    # nothing configured: "" is the explicit no-assertion, agent_type is the
    # harness label this integration knows it is
    assert event["agent_id"] == ""
    assert event["agent_type"] == "litellm"
    assert event["agent_workspace"] == ""
    assert event["agent_user"] == ""


def test_minted_step_id_rides_metadata_to_the_other_half(runtime, make_guard):
    guard = make_guard()
    data = request_data(call_id=None)  # no litellm_call_id from the host
    run(guard.async_pre_call_hook(None, None, data, "completion"))
    assert data["metadata"]["ogr_step_id"]  # minted and stashed
    run(guard.async_post_call_success_hook(data, None, response_body()))
    events = runtime.events
    assert events[0]["step_id"] == events[1]["step_id"]
    assert events[0]["step_id"] == data["metadata"]["ogr_step_id"]


def test_non_completion_call_types_pass_through_unjudged(runtime, make_guard):
    guard = make_guard()
    data = {"model": "text-embedding-3-small", "input": "hello",
            "litellm_call_id": "emb-1"}
    run(guard.async_pre_call_hook(None, None, data, "embeddings"))
    assert runtime.events == []


# ── block flows ────────────────────────────────────────────────────────────


def test_block_on_request_raises_before_the_model(runtime, make_guard):
    runtime.block(on_kind="step/request")
    guard = make_guard()
    with pytest.raises(OpenGuardrailsBlockedError) as err:
        run(guard.async_pre_call_hook(None, None, request_data(), "completion"))
    assert "step/request" in err.value.message
    assert err.value.verdict["decision"] == "block"
    assert [e["kind"] for e in runtime.events] == ["step/request"]
    assert guard.counters["blocks"] == 1


def test_block_on_response_raises_before_the_client_sees_it(runtime, make_guard):
    runtime.block(on_kind="step/response")
    guard = make_guard()
    data = request_data()
    run(guard.async_pre_call_hook(None, None, data, "completion"))
    with pytest.raises(OpenGuardrailsBlockedError) as err:
        run(guard.async_post_call_success_hook(data, None, response_body()))
    assert "step/response" in err.value.message
    assert [e["kind"] for e in runtime.events] == ["step/request",
                                                   "step/response"]


# ── degraded mode ──────────────────────────────────────────────────────────


def test_fail_open_on_dead_runtime_is_the_default(dead_url, make_guard):
    guard = make_guard(runtime_url=dead_url)
    data = request_data()
    assert run(guard.async_pre_call_hook(None, None, data, "completion")) is data
    response = response_body()
    assert run(
        guard.async_post_call_success_hook(data, None, response)
    ) is response
    assert guard.counters["evaluate_errors"] == 2  # loud, not silent


def test_fail_closed_denies_while_the_runtime_is_dark(dead_url, make_guard):
    guard = make_guard(runtime_url=dead_url, fail_mode="closed")
    with pytest.raises(OpenGuardrailsBlockedError) as err:
        run(guard.async_pre_call_hook(None, None, request_data(), "completion"))
    assert "fail_mode=closed" in err.value.message


def test_fail_closed_treats_nonempty_unjudged_as_could_not_look(runtime,
                                                                make_guard):
    def partial(event):
        return 200, {"event_id": "evt_p", "provider": "mock-runtime",
                     "decision": "allow",
                     "unjudged": ["payload.messages.0.content"]}

    runtime.responder = partial
    guard = make_guard(fail_mode="closed")
    with pytest.raises(OpenGuardrailsBlockedError):
        run(guard.async_pre_call_hook(None, None, request_data(), "completion"))
    # fail-open (default) proceeds: the record already says what went unjudged
    open_guard = make_guard()
    data = request_data("call-open")
    assert run(
        open_guard.async_pre_call_hook(None, None, data, "completion")
    ) is data


# ── modifications ──────────────────────────────────────────────────────────


def test_request_spans_are_applied_before_the_model_sees_them(runtime,
                                                              make_guard):
    content = "please email bob@example.com"
    start = content.index("bob@example.com")

    def redacting(event):
        verdict = {"event_id": "evt_r", "provider": "mock-runtime",
                   "decision": "allow"}
        if event["kind"] == "step/request":
            verdict["modifications"] = {"spans": [
                {"path": "payload.messages.0.content", "start": start,
                 "end": start + len("bob@example.com"),
                 "replacement": "${OGR_EMAIL_1}"},
            ]}
        return 200, verdict

    runtime.responder = redacting
    guard = make_guard()
    data = request_data()
    returned = run(guard.async_pre_call_hook(None, None, data, "completion"))
    assert returned["messages"][0]["content"] == "please email ${OGR_EMAIL_1}"
    # the wire saw the original; the model sees the redaction
    assert runtime.events[0]["payload"]["messages"][0]["content"] == content
    assert guard.counters["unresolved_spans"] == 0


def test_response_spans_rewrite_the_live_response(runtime, make_guard):
    content = "Sure, emailing bob@example.com now."
    start = content.index("bob@example.com")

    def redacting(event):
        verdict = {"event_id": "evt_r2", "provider": "mock-runtime",
                   "decision": "allow"}
        if event["kind"] == "step/response":
            verdict["modifications"] = {"spans": [
                {"path": "payload.choices.0.message.content", "start": start,
                 "end": start + len("bob@example.com"),
                 "replacement": "${OGR_EMAIL_1}"},
            ]}
        return 200, verdict

    runtime.responder = redacting
    guard = make_guard()
    data = request_data()
    run(guard.async_pre_call_hook(None, None, data, "completion"))
    response = response_body(content)
    out = run(guard.async_post_call_success_hook(data, None, response))
    assert out["choices"][0]["message"]["content"] == \
        "Sure, emailing ${OGR_EMAIL_1} now."


def test_unresolvable_spans_are_counted_not_silent(runtime, make_guard):
    def redacting(event):
        verdict = {"event_id": "evt_u", "provider": "mock-runtime",
                   "decision": "allow"}
        if event["kind"] == "step/request":
            verdict["modifications"] = {"spans": [
                {"path": "payload.no.such.place", "start": 0, "end": 3,
                 "replacement": "x"},
            ]}
        return 200, verdict

    runtime.responder = redacting
    guard = make_guard()
    run(guard.async_pre_call_hook(None, None, request_data(), "completion"))
    assert guard.counters["unresolved_spans"] == 1


# ── heartbeat / off switch ─────────────────────────────────────────────────


def test_heartbeat_carries_build_id_and_counters(runtime, make_guard):
    guard = make_guard()
    run(guard.async_pre_call_hook(None, None, request_data(), "completion"))
    assert guard.send_heartbeat(interval_s=30) is True
    beat = [r for r in runtime.requests if r["path"] == "/v1/heartbeat"][0]
    assert beat["body"]["integration"].startswith("openguardrails-litellm/")
    assert beat["body"]["agent_id"] == "test-agent"
    assert beat["body"]["interval_s"] == 30
    assert beat["body"]["counters"]["events_sent"] == 1


def test_unconfigured_integration_is_off_not_closed(runtime):
    guard = OpenGuardrails()  # no URL, no key, clean env
    data = request_data()
    assert run(guard.async_pre_call_hook(None, None, data, "completion")) is data
    response = response_body()
    assert run(
        guard.async_post_call_success_hook(data, None, response)
    ) is response
    assert runtime.events == []
