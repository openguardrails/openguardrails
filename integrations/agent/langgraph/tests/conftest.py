"""Offline test rig: sys.path for the src/ layout, the strict mock runtime
(see ``mock_runtime.py``), a dead port for outage tests, and clean OGR_* env."""

from __future__ import annotations

import socket
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from mock_runtime import MockRuntime  # noqa: E402 — needs the path above


@pytest.fixture()
def runtime():
    server = MockRuntime()
    yield server
    server.close()


@pytest.fixture()
def dead_url() -> str:
    """A URL nothing listens on — connection refused, i.e. a dark runtime."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    return f"http://127.0.0.1:{port}"


@pytest.fixture(autouse=True)
def _clean_ogr_env(monkeypatch):
    """Tests must not inherit a developer's real OGR_* configuration."""
    for name in (
        "OGR_RUNTIME_URL",
        "OGR_API_KEY",
        "OGR_TIMEOUT_S",
        "OGR_FAIL_MODE",
        "OGR_AGENT_ID",
        "OGR_AGENT_TYPE",
        "OGR_AGENT_WORKSPACE",
        "OGR_AGENT_USER",
    ):
        monkeypatch.delenv(name, raising=False)
