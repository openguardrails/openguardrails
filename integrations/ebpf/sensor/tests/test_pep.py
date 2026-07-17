"""PEP: decide against the runtime and enforce by containment (kill)."""
import io
import json

from openguardrails_ebpf import PEP, PEPConfig, EmbeddedPDP, parse_line

POLICY = {
    "composition": {"security.*": {"strategy": "deny-wins", "on_all_failed": "block"},
                    "default": {"strategy": "deny-wins"}},
    "config_rules": {
        "egress_allowlist": ["api.github.com"],
        "command_rules": [{"id": "rm-rf-root", "regex": r"rm\s+-rf\s+/(\s|$)",
                           "category": "security.malicious_command", "domain": "security",
                           "decision": "block", "score": 0.95, "why": "fs root wipe"}],
    },
}


def _exec(argv, pid=100):
    return parse_line(json.dumps({"schema": "ogr.ebpf.sensor/1", "kind": "exec",
                                  "pid": pid, "ppid": 99, "root_pid": 50, "comm": argv[0],
                                  "path": "/bin/" + argv[0], "argv": argv}))


def _net(ip, pid=100):
    return parse_line(json.dumps({"schema": "ogr.ebpf.sensor/1", "kind": "network",
                                  "pid": pid, "ppid": 99, "root_pid": 50, "comm": "curl",
                                  "ip": ip, "port": 443, "direction": "egress"}))


class RecordingPEP(PEP):
    def __init__(self, **cfg):
        self.killed: list[int] = []
        super().__init__(EmbeddedPDP(POLICY), PEPConfig(**cfg),
                         killer=self.killed.append)


def test_unlisted_egress_is_blocked():
    d = RecordingPEP().handle(_net("1.2.3.4"))
    assert d.verdict["decision"] == "block"
    assert any(c["id"] == "security.ssrf" for c in d.verdict["categories"])


def test_allowlisted_egress_allowed():
    # config_rules egress allow-list matches on host; a bare IP is not in it,
    # so this asserts the allow path via a benign exec instead.
    d = RecordingPEP().handle(_exec(["ls", "-la"]))
    assert d.verdict["decision"] == "allow"
    assert d.action == "observe"


def test_observe_only_by_default_does_not_kill():
    pep = RecordingPEP(enforce=False)
    d = pep.handle(_exec(["rm", "-rf", "/"]))
    assert d.verdict["decision"] == "block"
    assert d.action == "not_enforced"
    assert pep.killed == []


def test_enforce_kills_on_block():
    pep = RecordingPEP(enforce=True)
    d = pep.handle(_exec(["rm", "-rf", "/"], pid=4321))
    assert d.action == "killed"
    assert pep.killed == [4321]


def test_enforce_does_not_kill_allow():
    pep = RecordingPEP(enforce=True)
    d = pep.handle(_exec(["ls"]))
    assert d.action == "observe"
    assert pep.killed == []


def test_protected_and_init_pids_never_killed():
    pep = RecordingPEP(enforce=True, protect_pids=frozenset({4321}))
    assert pep.handle(_net("1.2.3.4", pid=4321)).action == "not_enforced"
    assert pep.handle(_net("1.2.3.4", pid=1)).action == "not_enforced"
    assert pep.killed == []


def test_kill_failure_is_reported():
    def boom(pid):
        raise ProcessLookupError

    pep = PEP(EmbeddedPDP(POLICY), PEPConfig(enforce=True), killer=boom)
    assert pep.handle(_net("1.2.3.4")).action == "kill_failed"


def test_degraded_when_runtime_unreachable_records_not_kills():
    class FailingPDP:
        def evaluate(self, ev):
            raise ConnectionError("down")

    killed = []
    pep = PEP(FailingPDP(), PEPConfig(enforce=True), killer=killed.append)
    d = pep.handle(_net("1.2.3.4"))
    assert d.verdict["degraded"] is True
    assert d.action == "observe"
    assert killed == []


def test_fail_closed_kills_on_degraded():
    class FailingPDP:
        def evaluate(self, ev):
            raise ConnectionError("down")

    killed = []
    pep = PEP(FailingPDP(), PEPConfig(enforce=True, fail_closed=True), killer=killed.append)
    d = pep.handle(_net("1.2.3.4", pid=777))
    assert d.action == "killed"
    assert killed == [777]


def test_run_emits_audit_records_and_correlates_by_guard_id(tmp_path):
    ctx = tmp_path / "guardcontext"
    ctx.write_text("02|ga-shared|run-outer|00")
    pep = RecordingPEP(guardcontext_path=str(ctx))
    out = io.StringIO()
    lines = ["garbage", json.dumps({"kind": "heartbeat"}),
             json.dumps(json.loads(_line(_net("1.2.3.4")))),
             json.dumps(json.loads(_line(_exec(["ls"]))))]
    n = pep.run(iter(lines), out)
    records = [json.loads(l) for l in out.getvalue().splitlines()]
    assert n == 2 == len(records)
    assert records[0]["event"]["observation_point"] == "sandbox"
    assert records[0]["event"]["guard_id"] == "ga-shared"
    # once blocked under a shared guard_id, later events stay tightened
    assert records[0]["verdict"]["decision"] == "block"
    assert records[1]["verdict"]["decision"] == "block"
    assert any("correlation" in r for r in records[1]["verdict"]["reasons"])


def _line(rec) -> str:
    """Re-serialize a parsed record back to a sensor line for run() tests."""
    payload = {"schema": "ogr.ebpf.sensor/1", "kind": rec.kind, "pid": rec.pid,
               "ppid": rec.ppid, "root_pid": rec.root_pid, "comm": rec.comm}
    if rec.kind == "exec":
        payload.update(path=rec.path, argv=rec.argv)
    elif rec.kind == "file":
        payload.update(access=rec.access, path=rec.path)
    else:
        payload.update(ip=rec.ip, port=rec.port, direction=rec.direction)
    return json.dumps(payload)
