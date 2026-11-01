"""Streaming: buffer the whole stream, judge it ONCE at stream end.

litellm's iterator hook wraps the entire stream, so this seat's v0.8
tail-hold is tail = ∞: nothing is released before the verdict, and a block
means no chunk ever reaches the client.
"""

import asyncio

import pytest

from openguardrails_litellm import OpenGuardrailsBlockedError

run = asyncio.run

CHUNKS = [
    {"model": "gpt-4o",
     "choices": [{"index": 0, "delta": {"content": "Hel"},
                  "finish_reason": None}]},
    {"model": "gpt-4o",
     "choices": [{"index": 0, "delta": {"content": "lo world"},
                  "finish_reason": None}]},
    {"model": "gpt-4o",
     "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
]


async def _stream(chunks):
    for chunk in chunks:
        yield chunk


def _drain(guard, data, chunks=CHUNKS):
    async def go():
        out = []
        async for chunk in guard.async_post_call_streaming_iterator_hook(
            None, _stream(chunks), data
        ):
            out.append(chunk)
        return out

    return run(go())


def test_stream_allow_evaluates_once_whole_then_releases(runtime, make_guard):
    guard = make_guard()
    data = {"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}],
            "litellm_call_id": "stream-1"}
    run(guard.async_pre_call_hook(None, None, data, "acompletion"))
    out = _drain(guard, data)
    assert out == CHUNKS  # released, in order, only after the verdict

    events = runtime.events
    assert [e["kind"] for e in events] == ["step/request", "step/response"]
    assert events[0]["step_id"] == events[1]["step_id"] == "stream-1"

    # ONE evaluate for the whole stream, reassembled by litellm's builder
    response = events[1]
    assert response["llm_protocol"] == "openai.chat"
    assert response["payload"]["choices"][0]["message"]["content"] == \
        "Hello world"
    timing = response["payload"]["timing"]
    assert set(timing) == {"started_at", "first_token_at", "completed_at"}


def test_stream_block_drops_the_held_tail(runtime, make_guard):
    runtime.block(on_kind="step/response")
    guard = make_guard()
    data = {"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}],
            "litellm_call_id": "stream-2"}
    with pytest.raises(OpenGuardrailsBlockedError):
        _drain(guard, data)
    # the stream never completed: nothing was yielded, no tool call can run


def test_stream_falls_back_to_canonical_when_no_raw_body_exists(runtime,
                                                                make_guard,
                                                                monkeypatch):
    import litellm

    monkeypatch.setattr(litellm, "stream_chunk_builder", None)
    guard = make_guard()
    tool_chunks = CHUNKS[:2] + [
        {"model": "gpt-4o",
         "choices": [{"index": 0, "delta": {"tool_calls": [
             {"index": 0, "id": "call_1",
              "function": {"name": "bash", "arguments": "{\"command\":"}},
         ]}, "finish_reason": None}]},
        {"model": "gpt-4o",
         "choices": [{"index": 0, "delta": {"tool_calls": [
             {"index": 0, "function": {"arguments": " \"ls\"}"}},
         ]}, "finish_reason": "tool_calls"}]},
    ]
    data = {"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}],
            "litellm_call_id": "stream-3"}
    out = _drain(guard, data, tool_chunks)
    assert out == tool_chunks

    event = runtime.events[0]
    assert event["llm_protocol"] == "canonical"
    payload = event["payload"]
    assert payload["text"] == "Hello world"
    assert payload["model"] == "gpt-4o"
    # tool-call fragments reassembled; arguments parsed when they parse
    assert payload["tool_calls"] == [
        {"id": "call_1", "name": "bash", "arguments": {"command": "ls"}},
    ]
    # no tokenizer here: usage is OMITTED, never reported as zeros
    assert "usage" not in payload


def test_stream_fail_closed_aborts_on_dead_runtime(dead_url, make_guard):
    guard = make_guard(runtime_url=dead_url, fail_mode="closed")
    data = {"model": "gpt-4o", "messages": [], "litellm_call_id": "stream-4"}
    with pytest.raises(OpenGuardrailsBlockedError):
        _drain(guard, data)


def test_stream_fail_open_releases_on_dead_runtime(dead_url, make_guard):
    guard = make_guard(runtime_url=dead_url)
    data = {"model": "gpt-4o", "messages": [], "litellm_call_id": "stream-5"}
    assert _drain(guard, data) == CHUNKS
