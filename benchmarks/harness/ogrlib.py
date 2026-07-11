"""Minimal OGR types for the benchmark harness (mirrors openguardrails-spec).

Self-contained (stdlib only) so the benchmark can be cloned and run on its own.
A detector returns a (decision, categories) pair; the harness maps decision to a
binary unsafe/safe prediction for scoring.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# decision -> treated as "flagged unsafe" for scoring
UNSAFE_DECISIONS = {"block", "require_approval", "redact"}

_PIPE_TO_SHELL = re.compile(r"(curl|wget)\b.*\|\s*(ba)?sh")


@dataclass
class Prov:
    source: str
    trust: str
    taint_tags: list[str] = field(default_factory=list)


@dataclass
class Event:
    kind: str
    observation_point: str
    payload: dict
    provenance: list[Prov] = field(default_factory=list)

    # -- helpers detectors use -----------------------------------------
    def command(self) -> str | None:
        if self.kind == "exec":
            return " ".join(self.payload.get("argv", [])) or None
        if self.kind == "tool_call" and self.payload.get("name") in ("shell.exec", "bash", "run_shell"):
            a = self.payload.get("arguments", {})
            return a.get("cmd") or a.get("command")
        return None

    def text(self) -> str:
        # everything a keyword scanner could see
        parts = [self.command() or "", self.payload.get("text", "")]
        a = self.payload.get("arguments")
        if isinstance(a, dict):
            parts.append(" ".join(f"{k}={v}" for k, v in a.items()))
        parts.append(self.payload.get("host", ""))
        return " ".join(p for p in parts if p)

    def is_untrusted(self) -> bool:
        return any(p.trust == "untrusted" for p in self.provenance)

    def tags(self) -> set[str]:
        t: set[str] = set()
        for p in self.provenance:
            t.update(p.taint_tags)
        return t

    def pipe_to_shell(self) -> bool:
        c = self.command()
        return bool(c and _PIPE_TO_SHELL.search(c))

    @staticmethod
    def from_case(d: dict) -> "Event":
        ev = d["event"]
        prov = [Prov(p["source"], p["trust"], p.get("taint_tags", []))
                for p in ev.get("provenance", [])]
        return Event(ev["kind"], ev.get("observation_point", "agent_hook"),
                     ev.get("payload", {}), prov)


def predicted_unsafe(decision: str) -> bool:
    return decision in UNSAFE_DECISIONS
