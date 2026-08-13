"""OGR v0.6 wire types — GuardEvent, Verdict, Provenance.

Stdlib only. These mirror schema/*.schema.json (protocol 0.6).
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any

OGR_VERSION = "0.6"



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
    # OGR v0.6: every field is FLAT, top-level — identity fields are scalars
    # and the agent_/sensor_ prefixes are the namespace (no subject/sensor
    # envelope). kind + payload alone is a complete event; the runtime
    # derives everything else.
    kind: str                       # see spec: tool_call|exec|tool_result|...
    payload: dict[str, Any] = field(default_factory=dict)
    observation_point: str | None = None   # absent = defaulted from kind
    # -- the agent identity fields (all optional; key-only floor otherwise) --
    agent_id: str | None = None        # org-unique; absent = derived from the API key
    agent_type: str | None = None      # a label ("hermes", "smartwork"), not an identity
    agent_workspace: str | None = None # named group of agents; absent = the key's workspace
    agent_owner: str | None = None     # builder / responsible party — attribute, not boundary
    agent_user: str | None = None      # who uses the agent THIS session; absent = one user
    sandbox_id: str | None = None
    parent_agent_id: str | None = None
    delegation_chain: list[str] = field(default_factory=list)
    attestation: str | None = None     # self_declared|inferred|network|mtls|gateway_api_key|client_key
    # -- the sensor axis --
    sensor_id: str | None = None       # which integration observed this
    sensor_type: str | None = None     # in_process|wrapper|proxy|kernel; absent = bypassable
    sensor_version: str | None = None
    # OGR v0.6: event identity is born at the runtime — never sent on the
    # wire, assigned locally by an in-process Runtime, returned on verdicts.
    event_id: str | None = None
    # Correlation hint across observation points; absent = the event itself.
    guard_id: str | None = None
    # Absent = the runtime's receive time.
    timestamp: str | None = None
    session_id: str | None = None
    llm_protocol: str | None = None
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
    latency_ms: float | None = None
    # Required by the spec when `decision` is `modify` or `redact`
    # (specification/verdict.md §modifications): {"kind": "redact", "spans": [
    #   {"path", "start", "end", "operator", "ref", "replacement"}]}.
    # An enforcement point that drops this field cannot carry out a redact
    # decision at all — it can only degrade it to allow (a leak) or to block.
    modifications: dict[str, Any] | None = None
    ogr_version: str = OGR_VERSION

    @classmethod
    def allow(cls, ev: GuardEvent, provider: str, reason: str = "no finding") -> "Verdict":
        return cls(ev.event_id, ev.guard_id, provider, "allow", reasons=[reason])

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
