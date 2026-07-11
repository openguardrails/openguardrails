"""OGR v0.1 wire types — GuardEvent, Verdict, Provenance.

Stdlib only. These mirror openguardrails-spec/schema/*.schema.json.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any

OGR_VERSION = "0.1"

# Decision severity order (most severe first) — see composition.md.
DECISIONS = ["block", "require_approval", "redact", "modify", "allow"]


def severity(decision: str) -> int:
    """Lower index == more severe. Unknown decisions are treated as most severe."""
    return DECISIONS.index(decision) if decision in DECISIONS else -1


@dataclass
class Provenance:
    source: str              # system|user|model|tool_result|web|mcp|file|retrieved
    trust: str               # trusted|untrusted|unverified
    ref: str | None = None
    taint_tags: list[str] = field(default_factory=list)


@dataclass
class GuardEvent:
    kind: str                       # see spec: tool_call|exec|tool_result|...
    observation_point: str          # gateway|agent_hook|sandbox
    subject: dict[str, Any]
    payload: dict[str, Any]
    event_id: str
    guard_id: str
    timestamp: str
    session_id: str | None = None
    llm_protocol: str | None = None
    context_refs: list[str] = field(default_factory=list)
    provenance: list[Provenance] = field(default_factory=list)
    ogr_version: str = OGR_VERSION

    def is_untrusted(self) -> bool:
        return any(p.trust == "untrusted" for p in self.provenance)

    def taint_tags(self) -> set[str]:
        tags: set[str] = set()
        for p in self.provenance:
            tags.update(p.taint_tags)
        return tags

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Category:
    id: str
    domain: str              # safety|security
    score: float = 1.0


@dataclass
class Verdict:
    event_id: str
    guard_id: str
    provider: str
    decision: str            # allow|block|require_approval|modify|redact
    categories: list[Category] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    evidence: list[dict[str, Any]] = field(default_factory=list)
    confidence: float | None = None
    latency_ms: float | None = None
    ogr_version: str = OGR_VERSION

    @classmethod
    def allow(cls, ev: GuardEvent, provider: str, reason: str = "no finding") -> "Verdict":
        return cls(ev.event_id, ev.guard_id, provider, "allow", reasons=[reason])

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
