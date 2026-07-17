"""Sensor records → sandbox-altitude GuardEvents, and guard-context stamping."""
import json

from openguardrails_ebpf import (
    GuardContext, parse_guardcontext, parse_line, to_guard_event,
)

SUBJECT = {"agent_id": "cc-1", "agent_type": "claude-code"}


def _rec(**over):
    base = {"schema": "ogr.ebpf.sensor/1", "kind": "exec", "pid": 10, "ppid": 9,
            "root_pid": 5, "comm": "bash", "path": "/bin/bash", "argv": ["bash"]}
    base.update(over)
    return parse_line(json.dumps(base))


def test_exec_event_is_sandbox_altitude():
    ev = to_guard_event(_rec(argv=["bash", "-c", "id"]), subject=SUBJECT)
    assert ev.observation_point == "sandbox"
    assert ev.kind == "exec"
    assert ev.payload["argv"] == ["bash", "-c", "id"]
    assert ev.payload["process"] == {"pid": 10, "ppid": 9, "comm": "bash"}
    assert ev.payload["sensor"] == {"engine": "ogr-ebpf", "root_pid": 5}
    assert ev.subject["sandbox_id"] == "sbx-5"
    assert ev.session_id == "run-5"
    assert ev.guard_id.startswith("ga-")


def test_file_event_carries_op_and_path():
    ev = to_guard_event(_rec(kind="file", access="write", path="/home/u/.bashrc",
                             argv=None), subject=SUBJECT)
    assert ev.kind == "file"
    assert ev.payload == {"op": "write", "path": "/home/u/.bashrc",
                          "process": {"pid": 10, "ppid": 9, "comm": "bash"},
                          "sensor": {"engine": "ogr-ebpf", "root_pid": 5}}


def test_network_event_carries_host_port_direction():
    ev = to_guard_event(_rec(kind="network", ip="1.2.3.4", port=443, comm="curl"),
                        subject=SUBJECT)
    assert ev.kind == "network"
    assert ev.payload["host"] == "1.2.3.4"
    assert ev.payload["port"] == 443
    assert ev.payload["direction"] == "egress"


def test_guardcontext_stamps_guard_and_session():
    ctx = parse_guardcontext("02|ga-outer|run-outer|01")
    assert ctx == GuardContext("02", "ga-outer", "run-outer", 1)
    ev = to_guard_event(_rec(), subject=SUBJECT, guard_context=ctx)
    assert ev.guard_id == "ga-outer"
    assert ev.session_id == "run-outer"


def test_guardcontext_validation_and_v01_receipt_bit():
    assert parse_guardcontext("junk") is None
    assert parse_guardcontext("03|g|s|00") is None
    assert parse_guardcontext("02||s|00") is None
    v01 = parse_guardcontext("01|g|s|03")
    assert v01.flags & 0b10 == 0     # forgeable receipt bit ignored on v01
    assert v01.flags & 0b01 == 1


def test_explicit_session_overrides_root_derived():
    ev = to_guard_event(_rec(), subject=SUBJECT, session_id="explicit")
    assert ev.session_id == "explicit"
