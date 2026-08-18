"""The client alone: wire shape, identity defaults, fail modes, heartbeat."""
from __future__ import annotations

from hermes_testkit import REQUIRED_FIELDS

from openguardrails_instrumentation_hermes.wire import INTEGRATION, OgrClient


def _client(**kwargs) -> OgrClient:
    return OgrClient(**kwargs)


def test_event_is_exactly_the_required_fields(guarded):
    """v0.8's whole deal: the nine required fields, nothing extra beyond the ONE
    optional one. The strict mock 400s any drift, so this is belt on top of braces.

    The optional field is ``integration``, restored to the event on 2026-08-17
    because the heartbeat's record is keyed on the integration NAME and therefore
    reports whichever replica beat last — it cannot say which build produced a
    given piece of traffic.
    """
    c = _client()
    verdict = c.evaluate("step/request", "s1", "canonical", {"messages": []})
    assert verdict is not None and verdict["decision"] == "allow"
    assert set(guarded.events[0]) == REQUIRED_FIELDS | {"integration"}
    # The SAME string the heartbeat sends — two literals would drift and each
    # would look right on its own.
    assert guarded.events[0]["integration"] == INTEGRATION


def test_four_tuple_defaults_are_empty_except_the_harness_label(guarded):
    """"" is the explicit no-assertion (identity floor: the API key answers);
    agent_type defaults to "hermes" — the one fact this plugin does know."""
    _client().evaluate("step/request", "s1", "canonical", {"messages": []})
    ev = guarded.events[0]
    assert ev["agent_type"] == "hermes"
    assert (ev["agent_id"], ev["agent_workspace"], ev["agent_user"]) == ("", "", "")


def test_four_tuple_from_env(guarded, clean_env):
    clean_env.setenv("OGR_AGENT_ID", "hermes-lab")
    clean_env.setenv("OGR_AGENT_TYPE", "hermes-fork")
    clean_env.setenv("OGR_AGENT_WORKSPACE", "research-agents")
    clean_env.setenv("OGR_AGENT_USER", "u-42")
    _client().evaluate("step/request", "s1", "canonical", {"messages": []})
    ev = guarded.events[0]
    assert ev["agent_id"] == "hermes-lab"
    assert ev["agent_type"] == "hermes-fork"
    assert ev["agent_workspace"] == "research-agents"
    assert ev["agent_user"] == "u-42"


def test_kwargs_override_env(guarded, clean_env):
    clean_env.setenv("OGR_AGENT_ID", "from-env")
    c = _client(agent_id="from-kwargs", fail_mode="closed")
    c.evaluate("step/request", "s1", "canonical", {"messages": []})
    assert guarded.events[0]["agent_id"] == "from-kwargs"
    assert c.fail_mode == "closed"


def test_wrong_key_is_no_verdict_and_counted(guarded, clean_env):
    """A 401 is a failed evaluate like any other: no verdict, fail mode
    decides, and the heartbeat counter is how the outage stays visible."""
    clean_env.setenv("OGR_API_KEY", "wrong-key")
    c = _client()
    assert c.evaluate("step/request", "s1", "canonical", {"messages": []}) is None
    assert c.counters["evaluate_errors"] == 1
    assert guarded.events == []


def test_unconfigured_client_returns_no_verdict(clean_env):
    c = _client()
    assert c.enabled is False
    assert c.evaluate("step/request", "s1", "canonical", {"messages": []}) is None


def test_unserializable_payload_degrades_to_str_not_a_crash(guarded):
    """The payload is whatever Hermes handed the hook; a non-JSON fragment
    must not take the event (or the hook) down."""
    verdict = _client().evaluate("step/request", "s1", "canonical",
                                 {"messages": [{"role": "user", "content": object()}]})
    assert verdict is not None
    assert guarded.events, "the event must still reach the wire"


# --------------------------------------------------------------------------- #
# fail modes (specification/degraded-mode.md)
# --------------------------------------------------------------------------- #

def test_fail_open_is_the_default(dark):
    """An integration that configures nothing fails open: no verdict, the
    action proceeds, the gap is counted."""
    c = _client()
    assert c.fail_mode == "open"
    verdict = c.evaluate("step/request", "s1", "canonical", {"messages": []})
    assert verdict is None
    assert c.blocked(verdict) is False
    assert c.counters["evaluate_errors"] == 1


def test_fail_closed_denies_when_the_runtime_is_dark(dark):
    dark.setenv("OGR_FAIL_MODE", "closed")
    c = _client()
    assert c.blocked(c.evaluate("step/request", "s1", "canonical", {"messages": []})) is True


def test_explicit_block_stops_the_agent_under_either_mode(clean_env):
    block = {"event_id": "e", "provider": "p", "decision": "block"}
    assert _client(fail_mode="open").blocked(block) is True
    assert _client(fail_mode="closed").blocked(block) is True


def test_unjudged_paths_deny_only_under_fail_closed(clean_env):
    """A non-empty `unjudged` is "could not look", which is not "found
    nothing" — the same situation as an outage, at a smaller size, so the
    same knob governs it."""
    partial = {"event_id": "e", "provider": "p", "decision": "allow",
               "unjudged": ["payload.tool_calls.0.arguments.command"]}
    assert _client(fail_mode="closed").blocked(partial) is True
    assert _client(fail_mode="open").blocked(partial) is False


def test_a_typoed_fail_mode_degrades_to_closed(clean_env):
    """A deployment that touched the knob wanted more than the default;
    rounding a typo down to open would silently remove that protection."""
    assert _client(fail_mode="colsed").fail_mode == "closed"


# --------------------------------------------------------------------------- #
# heartbeat
# --------------------------------------------------------------------------- #

def test_heartbeat_carries_the_build_id_and_counters(guarded, clean_env):
    clean_env.setenv("OGR_AGENT_ID", "hermes-lab")
    c = _client()
    c.evaluate("step/request", "s1", "canonical", {"messages": []})
    assert c.heartbeat() is True
    hb = guarded.heartbeats[0]
    # The integration build id lives HERE — it left the event in v0.8.
    assert hb["integration"] == INTEGRATION
    assert hb["agent_id"] == "hermes-lab"
    assert hb["counters"] == {"events_sent": 1, "evaluate_errors": 0}


def test_heartbeat_never_raises_while_dark(dark):
    assert _client().heartbeat() is False
