"""Reference detector #1 — config-based guardrail.

The simplest possible PoC guardrail: deterministic rules loaded from config.
No model, no network. Demonstrates that a `policy.json` (config) is a
first-class detector mechanism alongside an LLM.
"""
from __future__ import annotations

import re
import time

from . import Detector
from ..models import Category, GuardEvent, Verdict


def _command_string(ev: GuardEvent) -> str | None:
    """Pull a shell command out of an exec or tool_call event."""
    if ev.kind == "exec":
        return " ".join(ev.payload.get("argv", []))
    if ev.kind == "tool_call" and ev.payload.get("name") in (
        "shell.exec", "bash", "run_shell",
        # Hermes / common agent shell-tool names
        "terminal", "run_terminal_cmd", "execute_code", "run_code",
    ):
        args = ev.payload.get("arguments", {})
        return args.get("cmd") or args.get("command") or args.get("code")
    return None


class ConfigRulesDetector(Detector):
    provider = "ogr.poc.config_rules"
    handles = ("exec", "tool_call", "network")

    def __init__(self, config: dict):
        self.cfg = config
        self._patterns = [
            (re.compile(p["regex"]), p) for p in config.get("command_rules", [])
        ]

    def evaluate(self, ev: GuardEvent) -> Verdict:
        t0 = time.perf_counter()
        cats: list[Category] = []
        reasons: list[str] = []
        decision = "allow"

        # --- network egress allow-list ---------------------------------
        if ev.kind == "network":
            host = ev.payload.get("host", "")
            allow = self.cfg.get("egress_allowlist", [])
            if allow and host not in allow:
                decision = "block"
                cats.append(Category("security.ssrf", "security", 1.0))
                reasons.append(f"egress to '{host}' not in allow-list {allow}")

        # --- command pattern rules -------------------------------------
        cmd = _command_string(ev)
        if cmd:
            for rx, rule in self._patterns:
                if rx.search(cmd):
                    decision = _max_decision(decision, rule.get("decision", "block"))
                    cats.append(Category(rule["category"], rule.get("domain", "security"),
                                         float(rule.get("score", 1.0))))
                    reasons.append(f"matched rule '{rule['id']}': {rule['why']}")

            # secret-in-env exposed to a spawned process
            secret_env = [k for k in ev.payload.get("env_keys", [])
                          if any(s in k.upper() for s in self.cfg.get("secret_env_markers", []))]
            if secret_env and _command_string(ev):
                decision = _max_decision(decision, "require_approval")
                cats.append(Category("security.secret_leak", "security", 0.8))
                reasons.append(f"secrets exposed to process env: {secret_env}")

        v = Verdict(ev.event_id, ev.guard_id, self.provider, decision,
                    categories=cats, reasons=reasons or ["no rule matched"])
        v.latency_ms = round((time.perf_counter() - t0) * 1000, 3)
        return v


def _max_decision(a: str, b: str) -> str:
    from ..models import severity
    return a if severity(a) <= severity(b) else b
