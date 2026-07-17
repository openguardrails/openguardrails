"""Sandbox-altitude path detector — judges `file` GuardEvents against the OGR
policy's `sandbox` / `config_rules` path sections.

The reference `ConfigRulesDetector` covers `exec` and `network` (command
regexes and the egress allow-list) but not `file` reads/writes, which only the
kernel/sandbox altitude sees. This detector fills that gap so the eBPF sensor
can actually enforce `sandbox.deny_read`, `sandbox.deny_write`, and
`config_rules.secret_read_markers`. It ships with the integration rather than
the core because it is specific to the sandbox altitude; a vendor detector for
the same events composes alongside it under the normal OGR composition rules.
"""
from __future__ import annotations

import time
from fnmatch import fnmatch

from openguardrails import Category, GuardEvent, Verdict
from openguardrails.detectors import Detector


def _matches(path: str, entry: str) -> bool:
    """True if `path` falls under policy path `entry`. `~/x` widens to any-home
    (`/x` suffix or subtree) since the kernel altitude has no home context —
    stricter than the source entry, never looser."""
    e = entry.rstrip("/")
    if not e:
        return False
    if e.startswith("~/"):
        e = e[1:]                      # "~/.ssh" -> "/.ssh"
    if e.startswith("/"):
        return path == e or path.endswith(e) or (e + "/") in path
    base = path.rsplit("/", 1)[-1]
    return fnmatch(base, e) or ("/" + e + "/") in path or path.endswith("/" + e)


class SandboxPathDetector(Detector):
    provider = "ogr.ebpf.sandbox_path"
    handles = ("file",)

    def __init__(self, policy: dict):
        sandbox = policy.get("sandbox", {})
        config = policy.get("config_rules", {})
        self.deny_read = sandbox.get("deny_read", [])
        self.deny_write = sandbox.get("deny_write", [])
        self.secret_markers = config.get("secret_read_markers", [])

    def evaluate(self, ev: GuardEvent) -> Verdict:
        t0 = time.perf_counter()
        op = ev.payload.get("op", "read")
        path = ev.payload.get("path", "")
        decision = "allow"
        cats: list[Category] = []
        reasons: list[str] = []

        if op == "write":
            hit = next((e for e in self.deny_write if _matches(path, e)), None)
            if hit:
                decision = "block"
                cats.append(Category("security.malicious_command", "security", 0.9))
                reasons.append(f"write to protected path '{path}' (deny_write '{hit}')")
        else:  # read
            hit = next((e for e in self.deny_read if _matches(path, e)), None)
            if hit:
                decision = "block"
                cats.append(Category("security.secret_leak", "security", 0.9))
                reasons.append(f"read of credential path '{path}' (deny_read '{hit}')")
            else:
                marker = next((m for m in self.secret_markers if _matches(path, m)), None)
                if marker:
                    decision = "require_approval"
                    cats.append(Category("security.secret_leak", "security", 0.7))
                    reasons.append(f"read of secret-bearing path '{path}' (marker '{marker}')")

        v = Verdict(ev.event_id, ev.guard_id, self.provider, decision,
                    categories=cats, reasons=reasons or ["no path rule matched"])
        v.latency_ms = round((time.perf_counter() - t0) * 1000, 3)
        return v
