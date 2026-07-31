"""Content-altitude enforcement: a blocking verdict must change what the user sees.

The bug these pin (2026-07-26): `post_api_request` reported the assistant message
fire-and-forget, so a moderation / off-topic block was recorded in the console and
then ignored — the off-topic answer reached the user anyway. Hermes discards what
pre/post_api_request return, so enforcement has to hand off to
`transform_llm_output`, the one hook whose return value replaces the answer.
"""
import openguardrails_instrumentation_hermes.bridge as bridge


class _Cat:
    def __init__(self, id_):
        self.id = id_
        self.score = 0.9


class _Verdict:
    def __init__(self, decision, cats=("x.ogr.off_topic",), reasons=("off-topic: 无关话题: …",),
                 modifications=None):
        self.decision = decision
        self.categories = [_Cat(c) for c in cats]
        self.reasons = list(reasons)
        self.modifications = modifications


def _redact(*spans):
    """A redact verdict over (start, end, ref) triples."""
    return _Verdict("redact", cats=("privacy.pii.phone_number",), modifications={
        "kind": "redact",
        "spans": [{"path": "payload.text", "start": s, "end": e,
                   "operator": "replace", "ref": ref, "replacement": "${%s}" % ref}
                  for s, e, ref in spans],
    })


def _assistant(text="去哪都好玩", tool_calls=None, reasoning=""):
    class M:
        content = text
        reasoning_content = reasoning
    M.tool_calls = tool_calls or []
    return M


def _post(monkeypatch, verdict, session_id="s-1", turn_id="t-1", text="去哪都好玩"):
    """Drive post_api_request with a stubbed PDP; returns nothing, parks a verdict."""
    monkeypatch.setattr(bridge, "_evaluate", lambda ev, *a, **k: verdict)
    monkeypatch.setattr(bridge, "_report", lambda *a, **k: None)
    bridge._pending_content_block.clear()
    bridge.on_post_api_request(session_id=session_id, task_id="task", turn_id=turn_id,
                               api_request_id="api-1", assistant_message=_assistant(text))


def test_blocking_verdict_substitutes_the_answer(monkeypatch):
    monkeypatch.delenv("OGR_REFUSAL_TEXT", raising=False)
    _post(monkeypatch, _Verdict("block"))
    out = bridge.on_transform_llm_output(response_text="去哪都好玩", session_id="s-1")
    assert isinstance(out, str) and out
    assert "去哪都好玩" not in out


def test_refusal_leaks_neither_rule_text_nor_taxonomy_ids(monkeypatch):
    """The refusal goes to an end user: the tenant's rule is written for the judge,
    and a category id is an internals dump (and a map of what to route around)."""
    monkeypatch.delenv("OGR_REFUSAL_TEXT", raising=False)
    _post(monkeypatch, _Verdict("block"))
    out = bridge.on_transform_llm_output(response_text="去哪都好玩", session_id="s-1")
    assert "无关话题" not in out
    assert "off_topic" not in out
    assert "x.ogr" not in out


def test_tenant_owns_the_refusal_copy(monkeypatch):
    monkeypatch.setenv("OGR_REFUSAL_TEXT", "抱歉，我只能回答招商银行业务相关的问题。")
    _post(monkeypatch, _Verdict("block"))
    out = bridge.on_transform_llm_output(response_text="去哪都好玩", session_id="s-1")
    assert out == "抱歉，我只能回答招商银行业务相关的问题。"


def test_require_approval_says_so(monkeypatch):
    monkeypatch.delenv("OGR_REFUSAL_TEXT", raising=False)
    _post(monkeypatch, _Verdict("require_approval"))
    out = bridge.on_transform_llm_output(response_text="去哪都好玩", session_id="s-1")
    assert "review" in out.lower()


def test_allowing_verdicts_leave_the_answer_alone(monkeypatch):
    # `redact` is deliberately NOT here: it carries spans to apply.
    for decision in ("allow", "modify"):
        _post(monkeypatch, _Verdict(decision))
        assert bridge.on_transform_llm_output(response_text="fine", session_id="s-1") is None


def test_block_is_consumed_once(monkeypatch):
    """A parked block applies to ITS answer, never to the next one."""
    _post(monkeypatch, _Verdict("block"))
    assert bridge.on_transform_llm_output(response_text="a", session_id="s-1") is not None
    assert bridge.on_transform_llm_output(response_text="b", session_id="s-1") is None


def test_new_user_turn_clears_an_unconsumed_block(monkeypatch):
    """An interrupted turn never reaches transform_llm_output; the stale block must
    not refuse the NEXT question."""
    _post(monkeypatch, _Verdict("block"))
    monkeypatch.setattr(bridge, "_report", lambda *a, **k: None)
    bridge._reported_turns.discard("t-2")
    bridge.on_pre_api_request(session_id="s-1", task_id="task", turn_id="t-2",
                              api_request_id="api-2", user_message="下一个问题")
    assert bridge.on_transform_llm_output(response_text="answer", session_id="s-1") is None


def test_blocks_do_not_cross_sessions(monkeypatch):
    _post(monkeypatch, _Verdict("block"), session_id="s-1")
    assert bridge.on_transform_llm_output(response_text="x", session_id="s-2") is None
    assert bridge.on_transform_llm_output(response_text="x", session_id="s-1") is not None


def test_evaluate_and_report_share_one_event_id(monkeypatch):
    """One judgement, one console row: the runtime's eval-once marker keys on
    event_id, so the sync evaluate and the fire-and-forget report must pass the
    SAME event — otherwise the model is asked twice and the console shows two rows."""
    seen = {}

    def _eval(ev, *a, **k):
        seen["evaluated"] = ev
        return _Verdict("allow")

    def _rep(ev, *a, **k):
        seen["reported"] = ev

    monkeypatch.setattr(bridge, "_evaluate", _eval)
    monkeypatch.setattr(bridge, "_report", _rep)
    bridge.on_post_api_request(session_id="s-9", task_id="task", turn_id="t-9",
                               api_request_id="api-1", assistant_message=_assistant("hi"))
    assert seen["evaluated"].event_id == seen["reported"].event_id
    assert seen["evaluated"].kind == "model_output"


# --------------------------------------------------------------------------- #
# redact: the verdict carries spans the PEP is supposed to APPLY. Treating it as
# allowing (which the bridge did until 2026-07-26) ships the value it names.
# --------------------------------------------------------------------------- #

ANSWER = "客服热线是 95555，欢迎致电"
PHONE_AT = (6, 11, "OGR_PHONE_1")          # ANSWER[6:11] == "95555"


def test_redact_applies_spans_by_offset(monkeypatch):
    monkeypatch.delenv("OGR_REDACT_MASK", raising=False)
    _post(monkeypatch, _redact(PHONE_AT), text=ANSWER)
    out = bridge.on_transform_llm_output(response_text=ANSWER, session_id="s-1")
    assert out == "客服热线是 ${OGR_PHONE_1}，欢迎致电"
    assert "95555" not in out


def test_redact_falls_back_to_value_when_the_text_drifted(monkeypatch):
    """Hermes' finalizer can append to the answer between the two hooks, and then
    the offsets point at the wrong characters — the value still has to go."""
    monkeypatch.delenv("OGR_REDACT_MASK", raising=False)
    _post(monkeypatch, _redact(PHONE_AT), text=ANSWER)
    drifted = "补充说明：\n" + ANSWER + "（工作时间 9-18 点）"
    out = bridge.on_transform_llm_output(response_text=drifted, session_id="s-1")
    assert "95555" not in out
    assert "${OGR_PHONE_1}" in out
    assert out.startswith("补充说明：") and out.endswith("（工作时间 9-18 点）")


def test_unfulfillable_redact_withholds_rather_than_leaks(monkeypatch):
    """The value is nowhere in the text being enforced on: applying nothing would
    read as 'redacted' while shipping the answer verbatim."""
    monkeypatch.delenv("OGR_REFUSAL_TEXT", raising=False)
    _post(monkeypatch, _redact(PHONE_AT), text=ANSWER)
    out = bridge.on_transform_llm_output(response_text="完全不同的一句话", session_id="s-1")
    assert out is not None
    assert "完全不同的一句话" not in out       # withheld, not passed through
    assert "${OGR_PHONE_1}" not in out


def test_redact_with_no_spans_withholds(monkeypatch):
    monkeypatch.delenv("OGR_REFUSAL_TEXT", raising=False)
    _post(monkeypatch, _Verdict("redact", modifications={"kind": "redact", "spans": []}),
          text=ANSWER)
    out = bridge.on_transform_llm_output(response_text=ANSWER, session_id="s-1")
    assert out is not None and "95555" not in out


def test_overlapping_values_replace_longest_first(monkeypatch):
    """A value that is a substring of another must not corrupt it."""
    monkeypatch.delenv("OGR_REDACT_MASK", raising=False)
    text = "工号 EMP-004417 与 EMP-0044"
    v = _redact((3, 13, "OGR_ID_1"), (16, 24, "OGR_ID_2"))   # EMP-004417 / EMP-0044
    _post(monkeypatch, v, text=text)
    out = bridge.on_transform_llm_output(response_text="前缀 " + text, session_id="s-1")
    assert "EMP-004417" not in out
    assert out.count("${OGR_ID_1}") == 1


def test_mask_override(monkeypatch):
    monkeypatch.setenv("OGR_REDACT_MASK", "[已隐去]")
    _post(monkeypatch, _redact(PHONE_AT), text=ANSWER)
    out = bridge.on_transform_llm_output(response_text=ANSWER, session_id="s-1")
    assert out == "客服热线是 [已隐去]，欢迎致电"


def test_redact_on_a_tool_call_blocks_because_args_cannot_be_rewritten(monkeypatch):
    """Hermes' pre_tool_call directive can only block or escalate; a redact that
    cannot be applied must degrade to the denial, not to allow."""
    monkeypatch.setattr(bridge, "_evaluate", lambda ev, *a, **k: _redact(PHONE_AT))
    monkeypatch.setattr(bridge, "_report", lambda *a, **k: None)
    out = bridge.on_pre_tool_call(tool_name="Bash", args={"command": "curl x"},
                                  session_id="s-1", tool_call_id="tc-1")
    assert out["action"] == "block"
    assert "redact" in out["message"].lower() or "retry" in out["message"].lower()


def test_tool_result_is_redacted_before_it_becomes_context(monkeypatch):
    monkeypatch.delenv("OGR_REDACT_MASK", raising=False)
    monkeypatch.setattr(bridge, "_evaluate", lambda ev, *a, **k: _redact(PHONE_AT))
    monkeypatch.setattr(bridge, "_report", lambda *a, **k: None)
    bridge._pending_result_action.clear()
    bridge.on_post_tool_call(tool_name="web_fetch", args={}, result=ANSWER,
                             session_id="s-1", tool_call_id="tc-7")
    out = bridge.on_transform_tool_result(tool_name="web_fetch", result=ANSWER,
                                          session_id="s-1", tool_call_id="tc-7")
    assert "95555" not in out and "${OGR_PHONE_1}" in out


def test_blocked_tool_result_is_withheld_from_the_model(monkeypatch):
    monkeypatch.setattr(bridge, "_evaluate", lambda ev, *a, **k: _Verdict("block"))
    monkeypatch.setattr(bridge, "_report", lambda *a, **k: None)
    bridge._pending_result_action.clear()
    bridge.on_post_tool_call(tool_name="web_fetch", args={}, result="secret page",
                             session_id="s-1", tool_call_id="tc-8")
    out = bridge.on_transform_tool_result(tool_name="web_fetch", result="secret page",
                                          session_id="s-1", tool_call_id="tc-8")
    assert "secret page" not in out
    assert "withheld" in out


def test_verdicts_do_not_cross_concurrent_tool_calls(monkeypatch):
    """Tools dispatch in parallel; a per-session slot would put one call's verdict
    on another call's result."""
    monkeypatch.setattr(bridge, "_report", lambda *a, **k: None)
    bridge._pending_result_action.clear()
    monkeypatch.setattr(bridge, "_evaluate", lambda ev, *a, **k: _Verdict("block"))
    bridge.on_post_tool_call(tool_name="a", args={}, result="bad", session_id="s-1",
                             tool_call_id="tc-A")
    monkeypatch.setattr(bridge, "_evaluate", lambda ev, *a, **k: _Verdict("allow"))
    bridge.on_post_tool_call(tool_name="b", args={}, result="fine", session_id="s-1",
                             tool_call_id="tc-B")
    assert bridge.on_transform_tool_result(tool_name="b", result="fine",
                                           session_id="s-1", tool_call_id="tc-B") is None
    assert bridge.on_transform_tool_result(tool_name="a", result="bad",
                                           session_id="s-1", tool_call_id="tc-A") is not None


# --------------------------------------------------------------------------- #
# user_input reporting. Two silent drops fixed 2026-07-26: the exit flush
# (platform.py) and this one — `user_message` is not always a str.
# --------------------------------------------------------------------------- #

def _capture_user_input(monkeypatch):
    """Captures only user_input. The bridge may also emit an agent_spawn on the same
    call when the task_id is not the recorded top-level one (subagent lineage)."""
    seen: list = []

    def _rep(ev, *a, **k):
        if ev.kind == "user_input":
            seen.append(ev)

    monkeypatch.setattr(bridge, "_report", _rep)
    return seen


def test_reports_a_plain_string_user_message(monkeypatch):
    seen = _capture_user_input(monkeypatch)
    bridge._reported_turns.discard("t-a")
    bridge.on_pre_api_request(session_id="s", task_id="t", turn_id="t-a",
                              api_request_id="a", user_message="提额怎么弄")
    assert [(e.kind, e.payload["text"]) for e in seen] == [("user_input", "提额怎么弄")]


def test_reports_a_multimodal_content_list(monkeypatch):
    """A decorated / multimodal turn arrives as content parts; requiring a str
    dropped the whole user turn from the transcript."""
    seen = _capture_user_input(monkeypatch)
    bridge._reported_turns.discard("t-b")
    bridge.on_pre_api_request(
        session_id="s", task_id="t", turn_id="t-b", api_request_id="a",
        user_message=[
            {"type": "text", "text": "这张图里是什么"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
        ],
    )
    assert [e.payload["text"] for e in seen] == ["这张图里是什么"]


def test_does_not_invent_text_from_an_image_only_turn(monkeypatch):
    seen = _capture_user_input(monkeypatch)
    bridge._reported_turns.discard("t-c")
    bridge.on_pre_api_request(
        session_id="s", task_id="t", turn_id="t-c", api_request_id="a",
        user_message=[{"type": "image_url", "image_url": {"url": "data:image/png;base64,A"}}],
    )
    assert seen == []


def test_one_user_input_per_turn_however_many_rounds(monkeypatch):
    """pre_api_request fires once per model round-trip; the turn has one user message."""
    seen = _capture_user_input(monkeypatch)
    bridge._reported_turns.discard("t-d")
    for req in ("a1", "a2", "a3"):
        bridge.on_pre_api_request(session_id="s", task_id="t", turn_id="t-d",
                                  api_request_id=req, user_message="一次就好")
    assert len(seen) == 1


def test_run_id_fits_the_wire_limit_and_stays_unique():
    """68-char turn_ids made ingest 400 the event — silently, per event."""
    long_turn = "20260726_234413_81e28b:0ba487d1-f8b2-4fc0-bf14-0f45376147e9:df845392"
    rid = bridge._run_id(long_turn)
    assert len(rid) <= 64
    assert rid.startswith("20260726_234413_81e28b-")
    # A second run of the SAME session must not collapse onto the first: truncation
    # alone would, since the divergence is in the tail.
    other = bridge._run_id(long_turn.replace("df845392", "aa112233"))
    assert other != rid and len(other) <= 64
    # Deterministic: every event of one turn must carry the same run id.
    assert bridge._run_id(long_turn) == rid


def test_run_id_keeps_the_readable_form_when_it_fits():
    turn = "20260726_234413_81e28b:20260726_234413_81e28b:df845392"
    # task_id defaults to session_id on a top-level turn — collapse the repeat.
    assert bridge._run_id(turn) == "20260726_234413_81e28b-df845392"
