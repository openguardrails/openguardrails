"""Fixtures for the hermes suite; the doubles live in hermes_testkit.py.

The mock is deliberately STRICTER than a permissive server: it asserts every
event carries exactly the schema's required fields — no more (the schema is
additionalProperties: false; a stray v0.6 field like `timestamp` or
`session_id` must fail the suite, not slide through), no fewer (the
four-tuple is required even when empty). A conformance check that only
looked at what the code meant to send would miss exactly the drift this
rewrite exists to prevent.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

# The package is normally installed editable; fall back to the source tree so
# `python -m pytest integrations/agent/hermes` works from a bare checkout too.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import openguardrails_instrumentation_hermes.bridge as bridge  # noqa: E402
from hermes_testkit import API_KEY, RULESET, MockRuntime  # noqa: E402

_OGR_VARS = (
    "OGR_RUNTIME_URL", "OGR_API_KEY",
    "OGR_AGENT_ID", "OGR_AGENT_TYPE", "OGR_AGENT_WORKSPACE", "OGR_AGENT_USER",
    "OGR_FAIL_MODE", "OGR_TIMEOUT", "OGR_REFUSAL_TEXT", "OGR_REDACT_MASK",
    "OGR_SESSION_TAG",
    "OGR_LOCAL_REDACTION", "OGR_RULES_CACHE", "OGR_RESTORE_OUTPUT",
    "OGR_LOCAL_REDACTION_TIERS",
)


@pytest.fixture
def clean_env(monkeypatch, tmp_path):
    """No OGR config leaks in from the developer's shell — and the ruleset
    cache lands under tmp_path, never in the developer's ~/.openguardrails."""
    for var in _OGR_VARS:
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("OGR_RULES_CACHE", str(tmp_path / "rules.json"))
    bridge.reset()
    yield monkeypatch
    bridge.reset()


@pytest.fixture
def guarded(clean_env):
    """A configured bridge pointed at a strict mock runtime that serves the
    inline ruleset. Yields the mock; teardown asserts every event the suite
    sent was wire-conformant."""
    rt = MockRuntime(ruleset=RULESET)
    clean_env.setenv("OGR_RUNTIME_URL", rt.url)
    clean_env.setenv("OGR_API_KEY", API_KEY)
    bridge.reset()
    try:
        yield rt
        assert rt.violations == [], f"non-conformant events reached the wire: {rt.violations}"
    finally:
        rt.close()


@pytest.fixture
def protected(guarded):
    """`guarded`, with the ruleset fetched SYNCHRONOUSLY so a test can rely on
    masking from its first request (the plugin itself fetches in the
    background and masks with the cache meanwhile)."""
    client = bridge.get_client()
    if client.redactor.ruleset is None:
        client.redactor.store.fetch()
    assert client.redactor.ruleset is not None, "the mock's ruleset did not load"
    return guarded


@pytest.fixture
def dark(clean_env):
    """A configured bridge whose runtime is unreachable (nothing listens on
    port 9). Connection-refused resolves immediately, so the fail-mode tests
    cost no timeout."""
    clean_env.setenv("OGR_RUNTIME_URL", "http://127.0.0.1:9")
    clean_env.setenv("OGR_API_KEY", API_KEY)
    bridge.reset()
    return clean_env
