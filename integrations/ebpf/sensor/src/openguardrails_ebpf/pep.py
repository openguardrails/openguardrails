"""PEP — the OGR Policy Enforcement Point at the eBPF (sandbox) altitude.

The kernel sensor observes; this loop decides and enforces. Each sensor record
becomes a sandbox GuardEvent, is submitted to an OGR runtime (the PDP —
embedded reference `Runtime` or a remote endpoint), and the returned Verdict is
enforced.

Enforcement here is **post-hoc kill**, not pre-commit block: the observation
tracepoints fire after the syscall, so the sensor cannot deny the operation in
the kernel (that needs a BPF-LSM sensor, a documented next step). Instead, when
the runtime says `block`, the PEP terminates the offending process tree —
"contain the blast radius" rather than "prevent the first byte". This is why
correlation matters: the same action seen at the gateway/agent altitude can be
denied *before* it reaches the kernel; the eBPF altitude is the backstop for
whatever bypassed those layers.

Decision → action:
  allow / redact / modify   → observe (record only)
  block                     → kill the pid (with --enforce)
  require_approval          → cannot hold a syscall for a human here; recorded,
                              and killed only under --fail-closed

If the PDP is unreachable the event is never dropped: it is recorded with a
local degraded verdict, and no process is killed unless --fail-closed
(specification/degraded-mode.md — degrade safe, do not fail silently).
"""
from __future__ import annotations

import json
import os
import signal
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, TextIO

from openguardrails import GuardEvent, Runtime
from openguardrails.detectors.config_rules import ConfigRulesDetector

from .detector import SandboxPathDetector
from .events import GuardContext, new_id, parse_guardcontext, to_guard_event
from .sensor import SensorRecord, parse_line

DEGRADED_PROVIDER = "ogr.pep.ebpf/degraded"
KILL_DECISIONS = ("block",)


class EmbeddedPDP:
    """In-process PDP: the reference runtime with two composed detectors —
    `ConfigRulesDetector` (exec commands + network egress) and this package's
    `SandboxPathDetector` (file reads/writes at the kernel altitude)."""

    def __init__(self, policy: dict):
        self.runtime = Runtime(
            [ConfigRulesDetector(policy.get("config_rules", {})),
             SandboxPathDetector(policy)],
            policy)

    def evaluate(self, ev: GuardEvent) -> dict:
        return self.runtime.evaluate(ev).to_dict()


class RemotePDP:
    """Remote PDP over the public evaluate endpoint (GuardEvent in, Verdict out)."""

    def __init__(self, base_url: str, api_key: str, timeout: float = 2.0):
        import urllib.request  # noqa: PLC0415 — stdlib, kept local to the remote path
        self._request = urllib.request.Request
        self._urlopen = urllib.request.urlopen
        self.endpoint = base_url.rstrip("/") + "/api/public/ogr/v1/evaluate"
        self.api_key = api_key
        self.timeout = timeout

    def evaluate(self, ev: GuardEvent) -> dict:
        req = self._request(
            self.endpoint, data=json.dumps(ev.to_dict()).encode("utf-8"), method="POST",
            headers={"content-type": "application/json",
                     "authorization": f"Bearer {self.api_key}"})
        with self._urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))


@dataclass
class PEPConfig:
    agent_id: str = "ogr-ebpf-agent"
    agent_type: str = "ogr-ebpf.sandbox"
    principal: str | None = None
    session_id: str | None = None
    guardcontext_path: str | None = None
    guardcontext_ttl: float = 30.0
    enforce: bool = False           # act on block by killing the pid
    fail_closed: bool = False       # kill on require_approval / degraded too
    protect_pids: frozenset[int] = field(default_factory=frozenset)  # never kill these


@dataclass
class Decision:
    record: SensorRecord
    event: GuardEvent
    verdict: dict
    action: str                     # observe | killed | kill_failed | not_enforced


class PEP:
    def __init__(self, pdp, config: PEPConfig | None = None,
                 killer: Callable[[int], None] | None = None):
        self.pdp = pdp
        self.config = config or PEPConfig()
        self._kill = killer or (lambda pid: os.kill(pid, signal.SIGKILL))

    # -- guard-context ------------------------------------------------------
    def _guard_context(self, now: float | None = None) -> GuardContext | None:
        path = self.config.guardcontext_path
        if not path:
            return None
        try:
            age = (now if now is not None else time.time()) - os.stat(path).st_mtime
            if age > self.config.guardcontext_ttl:
                return None
            with open(path, encoding="utf-8") as f:
                return parse_guardcontext(f.read())
        except OSError:
            return None

    def _subject(self) -> dict:
        subject = {"agent_id": self.config.agent_id, "agent_type": self.config.agent_type}
        if self.config.principal:
            subject["principal"] = self.config.principal
        return subject

    # -- one record ---------------------------------------------------------
    def handle(self, rec: SensorRecord, now: float | None = None) -> Decision:
        ev = to_guard_event(rec, subject=self._subject(), session_id=self.config.session_id,
                            guard_context=self._guard_context(now))
        degraded = False
        try:
            verdict = self.pdp.evaluate(ev)
        except Exception as exc:  # never drop the observation
            degraded = True
            verdict = {"event_id": ev.event_id, "guard_id": ev.guard_id,
                       "provider": DEGRADED_PROVIDER, "decision": "allow",
                       "reasons": [f"runtime unreachable ({exc.__class__.__name__}); "
                                   "observation recorded, no enforcement"],
                       "degraded": True}
        action = self._enforce(rec, verdict, degraded)
        return Decision(rec, ev, verdict, action)

    def _enforce(self, rec: SensorRecord, verdict: dict, degraded: bool) -> str:
        decision = verdict.get("decision", "allow")
        should_kill = (
            (self.config.enforce and decision in KILL_DECISIONS)
            or (self.config.fail_closed and (degraded or decision == "require_approval"))
        )
        if not should_kill:
            return "observe" if decision in ("allow", "redact", "modify") else "not_enforced"
        if rec.pid in self.config.protect_pids or rec.pid <= 1:
            return "not_enforced"
        try:
            self._kill(rec.pid)
            return "killed"
        except (ProcessLookupError, PermissionError, OSError):
            return "kill_failed"

    # -- stream loop --------------------------------------------------------
    def run(self, lines: Iterable[str], out: TextIO) -> int:
        """Consume sensor NDJSON lines; write one audit record per event to
        `out` (`{"event": …, "verdict": …, "action": …}`). Returns the count."""
        n = 0
        for line in lines:
            rec = parse_line(line)
            if rec is None:
                continue
            d = self.handle(rec)
            out.write(json.dumps({"event": d.event.to_dict(), "verdict": d.verdict,
                                  "action": d.action}) + "\n")
            out.flush()
            n += 1
        return n
