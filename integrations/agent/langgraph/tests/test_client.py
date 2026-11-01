"""The hand-rolled wire: env configuration, the bearer header, None on any
failure (the caller's fail mode decides what that means), and the heartbeat
that keeps a degraded integration's gap visible."""

from __future__ import annotations

import pytest

from mock_runtime import API_KEY
from openguardrails_instrumentation_langgraph import INTEGRATION, OgrClient

EVENT = {
    "kind": "step/request",
    "step_id": "abc123",
    "agent_id": "",
    "agent_type": "langgraph",
    "agent_workspace": "",
    "agent_user": "",
    "llm_protocol": "canonical",
    "payload": {"messages": []},
}


def test_missing_runtime_url_is_a_setup_error_not_an_outage():
    with pytest.raises(ValueError):
        OgrClient()  # fail_mode governs a dark runtime, never an unconfigured one


def test_env_configuration_and_bearer_auth(runtime, monkeypatch):
    monkeypatch.setenv("OGR_RUNTIME_URL", runtime.url + "/")  # trailing slash tolerated
    monkeypatch.setenv("OGR_API_KEY", API_KEY)
    client = OgrClient()
    verdict = client.evaluate(EVENT)
    assert verdict is not None and verdict["decision"] == "allow"
    assert verdict["event_id"]  # identifiers are born at the runtime
    assert runtime.violations == []  # includes the Authorization check
    assert client.events_sent == 1


def test_evaluate_returns_none_on_5xx_and_counts_it(runtime):
    runtime.fail_statuses = [500]
    client = OgrClient(runtime.url, API_KEY)
    assert client.evaluate(EVENT) is None
    assert client.evaluate_errors == 1


def test_evaluate_returns_none_on_429_a_rate_limit_is_an_outage(runtime):
    runtime.fail_statuses = [429]
    client = OgrClient(runtime.url, API_KEY)
    assert client.evaluate(EVENT) is None
    assert client.evaluate_errors == 1


def test_evaluate_returns_none_when_unreachable(dead_url):
    client = OgrClient(dead_url, API_KEY, timeout=0.5)
    assert client.evaluate(EVENT) is None
    assert client.evaluate_errors == 1


def test_heartbeat_carries_the_build_id_and_counters(runtime):
    client = OgrClient(runtime.url, API_KEY)
    client.evaluate(EVENT)
    client.unresolved_spans = 3
    assert client.heartbeat(agent_id="invoice-bot", interval_s=30) is True
    beat = runtime.heartbeats[0]
    assert beat["integration"] == INTEGRATION  # the build id left the event in v0.8
    assert beat["agent_id"] == "invoice-bot"
    assert beat["interval_s"] == 30
    assert beat["counters"] == {"events_sent": 1, "evaluate_errors": 0, "unresolved_spans": 3}


def test_heartbeat_failure_is_fire_and_forget(dead_url):
    client = OgrClient(dead_url, API_KEY, timeout=0.5)
    assert client.heartbeat() is False  # warned, counted nothing, raised nothing
