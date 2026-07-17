"""SandboxPathDetector — file reads/writes judged against policy path sets."""
import json

from openguardrails import Runtime
from openguardrails_ebpf import SandboxPathDetector, parse_line, to_guard_event

POLICY = {
    "composition": {"security.*": {"strategy": "deny-wins", "on_all_failed": "block"},
                    "default": {"strategy": "deny-wins"}},
    "sandbox": {
        "deny_read": ["~/.ssh", "~/.aws", "~/.hermes/auth.json"],
        "deny_write": [".env", "~/.bashrc"],
    },
    "config_rules": {"secret_read_markers": ["/.config/gh/", "id_rsa", "credentials"]},
}
SUBJECT = {"agent_id": "a"}


def _file_event(op, path):
    rec = parse_line(json.dumps({"schema": "ogr.ebpf.sensor/1", "kind": "file",
                                 "pid": 1, "ppid": 0, "root_pid": 1, "comm": "x",
                                 "access": op, "path": path}))
    return to_guard_event(rec, subject=SUBJECT)


def _judge(op, path):
    return SandboxPathDetector(POLICY).evaluate(_file_event(op, path))


def test_deny_read_credential_dir_blocks():
    v = _judge("read", "/home/u/.ssh/id_rsa")
    assert v.decision == "block"
    assert v.categories[0].id == "security.secret_leak"


def test_deny_read_exact_file_blocks():
    assert _judge("read", "/home/u/.hermes/auth.json").decision == "block"


def test_secret_marker_read_requires_approval():
    # .config/gh matches a marker but not deny_read → softer decision
    v = _judge("read", "/home/u/.config/gh/hosts.yml")
    assert v.decision == "require_approval"
    assert v.categories[0].id == "security.secret_leak"


def test_deny_write_config_blocks():
    v = _judge("write", "/home/u/.bashrc")
    assert v.decision == "block"
    assert v.categories[0].id == "security.malicious_command"


def test_dotenv_write_blocks_by_basename():
    assert _judge("write", "/srv/app/.env").decision == "block"


def test_benign_read_allows():
    assert _judge("read", "/home/u/project/main.py").decision == "allow"


def test_write_to_deny_read_path_is_not_a_read_hit():
    # writing under ~/.ssh is not in deny_write; detector must not misfire as read
    assert _judge("write", "/home/u/.ssh/config").decision == "allow"


def test_composes_in_runtime_and_blocks_secret_read():
    rt = Runtime([SandboxPathDetector(POLICY)], POLICY)
    v = rt.evaluate(_file_event("read", "/home/u/.aws/credentials"))
    assert v.decision == "block"
