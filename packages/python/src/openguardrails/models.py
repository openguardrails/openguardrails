"""OGR v0.6 wire types — GuardEvent, Verdict, Subject, Provenance.

Stdlib only. These mirror schema/*.schema.json (protocol 0.6).
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, TypedDict

OGR_VERSION = "0.6"


class Subject(TypedDict, total=False):
    """Which agent is acting — the five-field agent identity plus actor lineage.

    Every field is optional: an empty subject (or none at all) is the key-only
    floor, where the runtime derives the agent from the API key (one key, one
    default agent) and attributes every session to one user. See
    specification/guard-event.md#subject.
    """

    agent_id: str          # org-unique agent identity; absent → derived from the API key
    agent_type: str        # kind of agent ("hermes", "openclaw", "smartwork") — a label, not an identity
    agent_workspace: str   # named group of agents; absent → the API key's workspace
    agent_owner: str       # builder / responsible party — an attribute, never a policy boundary
    agent_user: str        # who is using the agent THIS session; absent → one user
    sandbox_id: str
    parent_agent_id: str
    delegation_chain: list[str]
    attestation: str       # self_declared|inferred|network|mtls|gateway_api_key|client_key

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
    observation_point: str          # conversation|invocation|execution
    # {} is the key-only floor: the runtime derives the agent from the API key.
    subject: Subject
    payload: dict[str, Any]
    # OGR v0.6: event identity is born at the runtime — never sent on the
    # wire, assigned locally by an in-process Runtime, returned on verdicts.
    event_id: str | None = None
    # Correlation hint across observation points; absent = the event itself.
    guard_id: str | None = None
    # Absent = the runtime's receive time.
    timestamp: str | None = None
    session_id: str | None = None
    # WHICH integration observed this: {"id", "class"?, "version"?}. The
    # mechanism axis — orthogonal to observation_point's altitude, because an
    # eBPF probe and an in-process wrapper both assert "execution" while
    # differing completely in whether the agent could have evaded them.
    sensor: dict[str, Any] | None = None
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
