"""Platform reporter: instance identity, wire conversion, signing, disable-by-default."""
import atexit
import base64
import json
import time

from openguardrails import GuardEvent

from openguardrails_instrumentation_hermes.platform import (
    PepIdentity,
    PlatformReporter,
    agent_id,
    event_to_wire,
    subject_for,
)


def test_reporter_disabled_without_env(monkeypatch):
    monkeypatch.delenv("OGR_RUNTIME_URL", raising=False)
    monkeypatch.delenv("OGR_API_KEY", raising=False)
    r = PlatformReporter()
    assert r.enabled is False
    r.report({"event_id": "x"})  # must be a silent no-op


def test_subject_asserts_per_instance_identity(monkeypatch):
    monkeypatch.setenv("OGR_INSTANCE", "researcher")
    monkeypatch.setenv("OGR_AGENT_OWNER", "user:tom")
    monkeypatch.setenv("OGR_AGENT_USER", "user:tom")
    monkeypatch.setenv("OGR_AGENT_WORKSPACE", "research-agents")
    s = subject_for(sandbox_id="sbx")
    assert s["agent_id"] == "hermes-researcher" == agent_id()
    assert s["agent_type"] == "hermes"
    assert s["agent_owner"] == "user:tom"
    assert s["agent_user"] == "user:tom"
    assert s["agent_workspace"] == "research-agents"
    assert s["attestation"] == "client_key"
    assert s["sandbox_id"] == "sbx"


def test_event_to_wire_drops_empties():
    ev = GuardEvent(
        kind="tool_call", observation_point="invocation",
        subject=subject_for(), payload={"name": "bash"},
        event_id="evt-1", guard_id="ga-1", timestamp="2026-07-21T00:00:00Z",
        session_id="s-1",
    )
    wire = event_to_wire(ev)
    assert wire["event_id"] == "evt-1"
    assert "provenance" not in wire  # empty list dropped
    assert "llm_protocol" not in wire  # None dropped


def test_identity_signs_detached_jws(tmp_path, monkeypatch):
    monkeypatch.setenv("OGR_INSTANCE", "default")
    ident = PepIdentity(keyfile=str(tmp_path / "key.json"))
    assert ident.signature_header(b"{}") is None  # unenrolled → unsigned
    ident.key_id = "cafe0123cafe0123"
    value = ident.signature_header(b'{"batch":[]}')
    header_b64, empty, _sig = value.split(".")
    assert empty == ""
    header = json.loads(base64.urlsafe_b64decode(header_b64 + "=="))
    assert header == {"alg": "EdDSA", "kid": "cafe0123cafe0123",
                      "b64": False, "crit": ["b64"]}


# --------------------------------------------------------------------------- #
# Exit drain. The worker is a daemon thread parked on a 2s timer, so a one-shot
# process (`hermes -z`) used to exit with the queue still full — user_input events
# simply never reached the console, with nothing logged.
# --------------------------------------------------------------------------- #

def _reporter_with_stubbed_post(monkeypatch):
    monkeypatch.setenv("OGR_RUNTIME_URL", "http://runtime.invalid")
    monkeypatch.setenv("OGR_API_KEY", "k")
    posted: list[list[dict]] = []
    # Neither the worker thread nor the drain may touch the network in tests.
    monkeypatch.setattr(PlatformReporter, "_run", lambda self: None)
    monkeypatch.setattr(PlatformReporter, "_ensure_identity", lambda self: None)
    monkeypatch.setattr(PlatformReporter, "_post", lambda self, batch: posted.append(batch))
    return PlatformReporter(), posted


def test_flush_drains_what_the_timer_would_have_lost(monkeypatch):
    r, posted = _reporter_with_stubbed_post(monkeypatch)
    r.report({"event_id": "e1"})
    r.report({"event_id": "e2"})
    assert r.flush() == 2
    assert [e["event_id"] for batch in posted for e in batch] == ["e1", "e2"]


def test_flush_is_a_noop_when_nothing_is_queued(monkeypatch):
    r, posted = _reporter_with_stubbed_post(monkeypatch)
    assert r.flush() == 0
    assert posted == []


def test_flush_on_a_disabled_reporter_costs_nothing(monkeypatch):
    monkeypatch.delenv("OGR_RUNTIME_URL", raising=False)
    monkeypatch.delenv("OGR_API_KEY", raising=False)
    assert PlatformReporter().flush() == 0


def test_flush_respects_its_deadline_rather_than_holding_the_process(monkeypatch):
    """A slow runtime must cost one timeout on exit, not a hang."""
    r, _ = _reporter_with_stubbed_post(monkeypatch)

    def _slow(self, batch):
        time.sleep(0.05)

    monkeypatch.setattr(PlatformReporter, "_post", _slow)
    for i in range(500):        # 10 batches of 50
        r.report({"event_id": f"e{i}"})
    started = time.monotonic()
    r.flush(deadline_seconds=0.12)
    assert time.monotonic() - started < 1.0
    assert not r._queue.empty()          # gave up rather than blocking
    # Empty it: the atexit hook this reporter registered would otherwise try to
    # post the remainder for real, after monkeypatch has restored _post.
    r._queue.queue.clear()


def test_exit_drain_is_registered(monkeypatch):
    monkeypatch.setenv("OGR_RUNTIME_URL", "http://runtime.invalid")
    monkeypatch.setenv("OGR_API_KEY", "k")
    monkeypatch.setattr(PlatformReporter, "_run", lambda self: None)
    registered: list = []
    monkeypatch.setattr(atexit, "register", lambda fn, *a, **k: registered.append(fn))
    r = PlatformReporter()
    assert r.flush in registered
