"""Faithfulness of the LangChain → canonical conversion: nothing decomposed,
nothing invented, absence kept honest."""

from __future__ import annotations

from fakes import FakeTool, ai, human, system, tool_result
from openguardrails_instrumentation_langgraph.canonical import (
    request_payload,
    response_payload,
    tool_to_canonical,
)


def test_system_prompt_stays_messages_zero():
    payload = request_payload([system("rules"), human("hi")], None)
    assert payload["messages"][0] == {"role": "system", "content": "rules"}
    assert "tools" not in payload  # no inventory known → no empty-list invention


def test_tool_results_are_tool_role_messages():
    payload = request_payload([tool_result("42 files", "call_7")], None)
    assert payload["messages"][0] == {
        "role": "tool",
        "content": "42 files",
        "tool_call_id": "call_7",
    }


def test_assistant_history_keeps_prose_and_all_tool_calls_together():
    msg = ai(
        "Doing two things.",
        tool_calls=[
            {"id": "a", "name": "read", "args": {"path": "x"}},
            {"id": "b", "name": "write", "args": {"path": "y"}},
        ],
    )
    (canonical,) = request_payload([msg], None)["messages"]
    assert canonical["role"] == "assistant"
    assert canonical["content"] == "Doing two things."
    assert [tc["name"] for tc in canonical["tool_calls"]] == ["read", "write"]
    assert canonical["tool_calls"][0]["arguments"] == {"path": "x"}


def test_dict_messages_pass_through_untouched():
    already = {"role": "user", "content": "hi"}
    assert request_payload([already], None)["messages"][0] is already


def test_openai_style_tool_dicts_pass_through_untouched():
    schema = {"type": "function", "function": {"name": "bash", "parameters": {}}}
    assert tool_to_canonical(schema) is schema


def test_response_block_content_splits_text_and_reasoning():
    msg = ai([
        {"type": "reasoning", "reasoning": "think first"},
        {"type": "text", "text": "then speak"},
    ])
    payload = response_payload(msg, "t0", "t1")
    assert payload["text"] == "then speak"
    assert payload["reasoning"] == "think first"


def test_usage_is_transcribed_never_fabricated():
    with_usage = response_payload(
        ai("x", usage_metadata={
            "input_tokens": 10,
            "output_tokens": 2,
            "input_token_details": {"cache_read": 8},
            "output_token_details": {"reasoning": 1},
        }),
        "t0", "t1",
    )
    assert with_usage["usage"] == {
        "input_tokens": 10,
        "output_tokens": 2,
        "cache_read_tokens": 8,
        "reasoning_tokens": 1,
    }
    # No provider report → the field is OMITTED; zeros would be a lie.
    assert "usage" not in response_payload(ai("x"), "t0", "t1")


def test_timing_always_rides_the_response():
    payload = response_payload(ai("x"), "2026-08-15T00:00:00Z", "2026-08-15T00:00:01Z")
    assert payload["timing"] == {
        "started_at": "2026-08-15T00:00:00Z",
        "completed_at": "2026-08-15T00:00:01Z",
    }


def test_empty_prose_is_absent_not_empty_string():
    msg = ai("", tool_calls=[{"id": "a", "name": "bash", "args": {}}])
    payload = response_payload(msg, "t0", "t1")
    assert "text" not in payload
    assert payload["tool_calls"] == [{"id": "a", "name": "bash", "arguments": {}}]
