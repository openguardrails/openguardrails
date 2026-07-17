"""Sensor records → OGR GuardEvents at the `sandbox` observation point.

specification/guard-event.md assigns real `execve` / `network` / `filesystem`
behavior to `observation_point: "sandbox"` — the "adversary-proof, agent can't
bypass" altitude. This module is the mapping:

    exec    → kind "exec"     payload {argv, comm, ...}
    file     → kind "file"    payload {op: read|write, path}
    network  → kind "network" payload {host, port, direction}

Correlation follows specification/provenance-and-context.md. The kernel cannot
carry the `ogr-guardcontext` header, so when an agent-hook adapter propagates
one out of band (a file the harness writes before a tool runs), the sensor
stamps its `guard_id` / `session_id` onto events in the tracked tree; otherwise
the sensor is the first observer of the action and mints a fresh `guard_id`,
with `session_id` derived from the tree root so one agent run correlates.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from openguardrails import GuardEvent

from .sensor import SensorRecord

KIND_MAP = {"exec": "exec", "file": "file", "network": "network"}


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class GuardContext:
    version: str
    guard_id: str
    session_id: str
    flags: int = 0


def parse_guardcontext(text: str) -> GuardContext | None:
    """Parse `ogr-guardcontext`: `02|<guard_id>|<session_id>|<flags>`.

    Bit 1 (approval receipt attached) is advisory and carries no authority
    here; version `01` with the receipt bit set is treated as carrying none,
    since that bit was forgeable by the propagating party (spec).
    """
    parts = text.strip().split("|")
    if len(parts) != 4:
        return None
    version, guard_id, session_id, flags = parts
    if version not in ("01", "02") or not guard_id:
        return None
    try:
        bits = int(flags, 16)
    except ValueError:
        bits = 0
    if version == "01":
        bits &= ~0b10
    return GuardContext(version, guard_id, session_id, bits)


def to_guard_event(rec: SensorRecord, *, subject: dict, session_id: str | None = None,
                   guard_context: GuardContext | None = None,
                   timestamp: str | None = None) -> GuardEvent:
    """Build the sandbox-altitude GuardEvent for one sensor record.

    `subject` carries at least `agent_id`; `sandbox_id` defaults to the tree
    root so events from one sensor run share a sandbox identity.
    """
    kind = KIND_MAP[rec.kind]
    process = {"pid": rec.pid, "ppid": rec.ppid, "comm": rec.comm}
    if rec.uid is not None:
        process["uid"] = rec.uid

    if kind == "exec":
        payload = {"argv": rec.argv or [rec.path], "comm": rec.comm, "path": rec.path}
    elif kind == "file":
        payload = {"op": rec.access or "read", "path": rec.path}
    else:
        payload = {"host": rec.ip, "direction": rec.direction}
        if rec.port is not None:
            payload["port"] = rec.port
    payload["process"] = process
    payload["sensor"] = {"engine": "ogr-ebpf", "root_pid": rec.root_pid}

    subject = dict(subject)
    subject.setdefault("sandbox_id", f"sbx-{rec.root_pid}")

    return GuardEvent(
        kind=kind,
        observation_point="sandbox",
        subject=subject,
        payload=payload,
        event_id=new_id("evt"),
        guard_id=guard_context.guard_id if guard_context else new_id("ga"),
        timestamp=timestamp or _now(),
        session_id=(guard_context.session_id if guard_context and guard_context.session_id
                    else session_id or f"run-{rec.root_pid}"),
    )
