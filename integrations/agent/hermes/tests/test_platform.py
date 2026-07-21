"""Platform reporter: instance identity, wire conversion, signing, disable-by-default."""
import base64
import json

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
    monkeypatch.setenv("OGR_PRINCIPAL", "user:tom")
    s = subject_for(sandbox_id="sbx")
    assert s["agent_id"] == "hermes-researcher" == agent_id()
    assert s["agent_type"] == "hermes"
    assert s["attestation"] == "client_key"
    assert s["sandbox_id"] == "sbx"


def test_event_to_wire_drops_empties():
    ev = GuardEvent(
        kind="tool_call", observation_point="agent_hook",
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
