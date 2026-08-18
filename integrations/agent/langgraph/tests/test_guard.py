"""The recipe, end to end against the strict mock runtime: two POSTs per
model call, one step_id binding them, block enforced as GuardrailBlocked at
both refusable moments, fail-open by default and fail-closed by choice."""

from __future__ import annotations

import sys
import types

import pytest

from mock_runtime import API_KEY
from fakes import FakeChatModel, FakeTool, ai, human, system, tool_result
from openguardrails_instrumentation_langgraph import GuardrailBlocked, OgrClient, guard


def make_guarded(runtime, model=None, **kwargs):
    client = OgrClient(runtime.url, API_KEY, timeout=5)
    return guard(model or FakeChatModel(), client=client, **kwargs)


CONVO = [system("You are an invoice bot."), human("Pay invoice #42.")]


# ── the allow flow ─────────────────────────────────────────────────────────


def test_allow_flow_sends_both_halves_and_returns_the_response(runtime):
    response = ai(
        "Paying now.",
        tool_calls=[{"id": "call_1", "name": "pay", "args": {"invoice": 42}}],
        usage_metadata={"input_tokens": 100, "output_tokens": 20},
        response_metadata={"model_name": "gpt-5"},
    )
    tools = [FakeTool("pay", "Pay an invoice", {"invoice": {"type": "integer"}})]
    guarded = make_guarded(runtime, FakeChatModel([response]), tools=tools)

    result = guarded.invoke(CONVO)

    assert result is response
    assert runtime.violations == []
    assert [e["kind"] for e in runtime.events] == ["step/request", "step/response"]

    request, resp = runtime.events
    assert request["llm_protocol"] == "canonical"
    # The system prompt is messages[0], as the provider would see it.
    assert request["payload"]["messages"][0] == {
        "role": "system",
        "content": "You are an invoice bot.",
    }
    assert request["payload"]["messages"][1]["role"] == "user"
    assert request["payload"]["tools"] == [
        {"name": "pay", "description": "Pay an invoice", "parameters": {"invoice": {"type": "integer"}}}
    ]
    assert resp["payload"]["text"] == "Paying now."
    assert resp["payload"]["tool_calls"] == [
        {"id": "call_1", "name": "pay", "arguments": {"invoice": 42}}
    ]
    assert resp["payload"]["model"] == "gpt-5"
    assert resp["payload"]["usage"] == {"input_tokens": 100, "output_tokens": 20}
    timing = resp["payload"]["timing"]
    assert timing["started_at"] <= timing["completed_at"]  # ISO-8601 sorts
    assert "first_token_at" not in timing  # buffered call: absence is honest


def test_step_id_pairs_the_halves_and_is_fresh_per_call(runtime):
    guarded = make_guarded(runtime, FakeChatModel([ai("a"), ai("b")]))
    guarded.invoke(CONVO)
    guarded.invoke(CONVO)
    ids = [e["step_id"] for e in runtime.events]
    assert ids[0] == ids[1] and ids[2] == ids[3]  # halves bound
    assert ids[0] != ids[2]  # never reused
    assert runtime.violations == []


def test_tool_results_travel_in_the_next_request(runtime):
    guarded = make_guarded(runtime)
    convo = CONVO + [
        ai("", tool_calls=[{"id": "call_9", "name": "bash", "args": {"command": "ls"}}]),
        tool_result("README.md", "call_9"),
    ]
    guarded.invoke(convo)
    messages = runtime.events[0]["payload"]["messages"]
    assert messages[2]["tool_calls"] == [{"id": "call_9", "name": "bash", "arguments": {"command": "ls"}}]
    assert messages[3] == {"role": "tool", "content": "README.md", "tool_call_id": "call_9"}
    assert runtime.violations == []


# ── block enforcement ──────────────────────────────────────────────────────


def test_block_on_request_never_calls_the_model(runtime):
    runtime.verdicts = [{"decision": "block", "findings": [
        {"category": "security.cmd.data_exfiltration", "action": "block"}
    ]}]
    model = FakeChatModel()
    with pytest.raises(GuardrailBlocked) as exc:
        make_guarded(runtime, model).invoke(CONVO)
    assert exc.value.kind == "step/request"
    assert "security.cmd.data_exfiltration" in str(exc.value)
    assert model.calls == []  # the model was never called
    assert len(runtime.events) == 1  # and there was no response half to send


def test_block_on_response_raises_before_the_agent_can_act(runtime):
    runtime.verdicts = [{"decision": "allow"}, {"decision": "block"}]
    model = FakeChatModel([ai("", tool_calls=[{"id": "c", "name": "bash", "args": {}}])])
    with pytest.raises(GuardrailBlocked) as exc:
        make_guarded(runtime, model).invoke(CONVO)
    assert exc.value.kind == "step/response"
    assert len(model.calls) == 1  # the model DID answer; acting is what's refused
    assert len(runtime.events) == 2


# ── degraded mode ──────────────────────────────────────────────────────────


def test_fail_open_is_the_default(dead_url):
    model = FakeChatModel([ai("proceeded")])
    client = OgrClient(dead_url, API_KEY, timeout=0.5)
    result = guard(model, client=client).invoke(CONVO)
    assert result.content == "proceeded"  # both unjudged halves proceeded
    assert client.evaluate_errors == 2  # ...and the gap is counted, loudly


def test_fail_closed_stops_the_step_with_no_verdict(dead_url):
    model = FakeChatModel()
    client = OgrClient(dead_url, API_KEY, timeout=0.5)
    with pytest.raises(GuardrailBlocked) as exc:
        guard(model, client=client, fail_mode="closed").invoke(CONVO)
    assert exc.value.verdict is None  # "could not look", not "found nothing"
    assert model.calls == []


def test_fail_closed_treats_unjudged_paths_as_could_not_look(runtime):
    runtime.verdicts = [{"decision": "allow", "unjudged": ["payload.messages.1.content"]}]
    with pytest.raises(GuardrailBlocked):
        make_guarded(runtime, fail_mode="closed").invoke(CONVO)


def test_fail_mode_is_validated(runtime):
    with pytest.raises(ValueError):
        make_guarded(runtime, fail_mode="ajar")


# ── identity ───────────────────────────────────────────────────────────────


def test_five_tuple_defaults_empty_except_agent_type(runtime):
    make_guarded(runtime).invoke(CONVO)
    event = runtime.events[0]
    assert event["agent_type"] == "langgraph"  # the one thing this harness knows
    for field in ("agent_id", "agent_workspace", "agent_user"):
        assert event[field] == ""  # explicit "no assertion", present on the wire
    assert runtime.violations == []


def test_five_tuple_env_fills_and_constructor_wins(runtime, monkeypatch):
    monkeypatch.setenv("OGR_AGENT_ID", "env-bot")
    monkeypatch.setenv("OGR_AGENT_USER", "u-env")
    make_guarded(runtime, agent_id="invoice-bot", agent_workspace="finance-agents").invoke(CONVO)
    event = runtime.events[0]
    assert event["agent_id"] == "invoice-bot"  # constructor beats env
    assert event["agent_user"] == "u-env"  # env beats default
    assert event["agent_workspace"] == "finance-agents"
    assert runtime.violations == []


# ── modification spans ─────────────────────────────────────────────────────


def test_response_spans_redact_what_the_agent_sees(runtime):
    runtime.verdicts = [
        {"decision": "allow"},
        {"decision": "allow", "modifications": {"spans": [
            {"path": "payload.text", "start": 6, "end": 21, "replacement": "${OGR_EMAIL_1}"}
        ]}},
    ]
    original = ai("Email bob@example.com about it.")
    result = make_guarded(runtime, FakeChatModel([original])).invoke(CONVO)
    assert result.content == "Email ${OGR_EMAIL_1} about it."
    assert original.content == "Email bob@example.com about it."  # caller's object untouched


def test_request_spans_redact_what_the_model_sees(runtime):
    runtime.verdicts = [
        {"decision": "allow", "modifications": {"spans": [
            {"path": "payload.messages.1.content", "start": 12, "end": 15, "replacement": "${OGR_N_1}"},
            {"path": "payload.tool_calls.0.arguments.x", "start": 0, "end": 1, "replacement": "?"},
        ]}},
    ]
    model = FakeChatModel([ai("ok")])
    client = OgrClient(runtime.url, API_KEY)
    guard(model, client=client).invoke(CONVO)
    sent = model.calls[0]
    assert sent[1].content == "Pay invoice ${OGR_N_1}."
    assert CONVO[1].content == "Pay invoice #42."  # never mutate the graph state
    assert client.unresolved_spans == 1  # the unresolvable path was COUNTED


# ── LangGraph plumbing ─────────────────────────────────────────────────────


def test_bind_tools_rewraps_and_declares_the_inventory(runtime):
    guarded = make_guarded(runtime).bind_tools([FakeTool("bash", "Run a command")])
    guarded.invoke(CONVO)
    assert guarded.model.bound_tools is not None  # the real bind happened
    assert runtime.events[0]["payload"]["tools"] == [{"name": "bash", "description": "Run a command"}]
    assert runtime.violations == []


def test_graph_state_dict_input_is_accepted(runtime):
    make_guarded(runtime).invoke({"messages": CONVO})
    assert len(runtime.events[0]["payload"]["messages"]) == 2
    assert runtime.violations == []


def test_ainvoke_runs_the_same_recipe(runtime):
    import asyncio

    guarded = make_guarded(runtime, FakeChatModel([ai("async ok")]))
    result = asyncio.run(guarded.ainvoke(CONVO))
    assert result.content == "async ok"
    assert [e["kind"] for e in runtime.events] == ["step/request", "step/response"]
    assert runtime.events[0]["step_id"] == runtime.events[1]["step_id"]
    assert runtime.violations == []


def test_no_silent_bypass_surface(runtime):
    # A call path the guard does not judge must fail loudly, never delegate.
    guarded = make_guarded(runtime)
    with pytest.raises(AttributeError):
        guarded.stream(CONVO)


def test_works_against_a_sys_modules_langchain(runtime, monkeypatch):
    """The duck-typed surface, proven against message classes that claim to
    BE langchain_core's — installed via sys.modules, no real package."""
    messages_mod = types.ModuleType("langchain_core.messages")

    class SystemMessage:
        type = "system"

        def __init__(self, content):
            self.content = content

    class HumanMessage:
        type = "human"

        def __init__(self, content):
            self.content = content

    messages_mod.SystemMessage = SystemMessage
    messages_mod.HumanMessage = HumanMessage
    package = types.ModuleType("langchain_core")
    package.messages = messages_mod
    monkeypatch.setitem(sys.modules, "langchain_core", package)
    monkeypatch.setitem(sys.modules, "langchain_core.messages", messages_mod)

    from langchain_core.messages import HumanMessage as H, SystemMessage as S

    make_guarded(runtime).invoke([S("be careful"), H("hello")])
    assert runtime.events[0]["payload"]["messages"] == [
        {"role": "system", "content": "be careful"},
        {"role": "user", "content": "hello"},
    ]
    assert runtime.violations == []


def test_package_imports_without_langchain_installed():
    # The import above already proved it, but keep the claim explicit: the
    # package must never pull the host application's framework in.
    for mod in ("langgraph", "langchain", "langchain_core"):
        assert mod not in sys.modules or not getattr(sys.modules[mod], "__file__", None)
