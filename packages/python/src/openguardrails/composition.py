"""Composition — combine many vendors' verdicts into one effective verdict.

Implements the mechanism from openguardrails-spec/specification/composition.md.
The deployer owns the choice of strategy; OGR owns the mechanism.
"""
from __future__ import annotations

from .models import Category, GuardEvent, Verdict, severity

COMPOSED_PROVIDER = "ogr.runtime/composed"


def _merge(ev: GuardEvent, decision: str, verdicts: list[Verdict], reason_prefix: str) -> Verdict:
    cats: dict[str, Category] = {}
    reasons: list[str] = []
    evidence: list[dict] = []
    for v in verdicts:
        for c in v.categories:
            if c.id not in cats or c.score > cats[c.id].score:
                cats[c.id] = c
        for r in v.reasons:
            reasons.append(f"[{v.provider}] {r}")
        evidence.append({"provider": v.provider, "decision": v.decision,
                         "latency_ms": v.latency_ms})
    out = Verdict(ev.event_id, ev.guard_id, COMPOSED_PROVIDER, decision,
                  categories=list(cats.values()),
                  reasons=[reason_prefix] + reasons, evidence=evidence)
    return out


def compose(ev: GuardEvent, verdicts: list[Verdict], rule: dict) -> Verdict:
    """rule = {strategy, quorum?, on_all_failed?} for the matched category group."""
    strategy = rule.get("strategy", "deny-wins")
    if not verdicts:
        return Verdict(ev.event_id, ev.guard_id, COMPOSED_PROVIDER,
                       rule.get("on_all_failed", "allow"),
                       reasons=["no detector produced a verdict"])

    if strategy == "deny-wins":
        winner = min(verdicts, key=lambda v: severity(v.decision))
        return _merge(ev, winner.decision, verdicts, f"deny-wins → {winner.decision}")

    if strategy == "quorum":
        q = rule.get("quorum", {"count": 2, "min_score": 0.0})
        votes = [v for v in verdicts if v.decision != "allow"
                 and any(c.score >= q.get("min_score", 0.0) for c in v.categories) or
                 (v.decision != "allow" and not v.categories)]
        if len(votes) >= q.get("count", 2):
            winner = min(votes, key=lambda v: severity(v.decision))
            return _merge(ev, winner.decision, verdicts,
                          f"quorum {len(votes)}/{q.get('count')} → {winner.decision}")
        return _merge(ev, "allow", verdicts, "quorum not reached → allow")

    if strategy == "first-available":
        return _merge(ev, verdicts[0].decision, verdicts, "first-available")

    # unknown strategy → conservative
    winner = min(verdicts, key=lambda v: severity(v.decision))
    return _merge(ev, winner.decision, verdicts, f"default most_severe → {winner.decision}")


def select_rule(verdicts: list[Verdict], composition: dict) -> dict:
    """Pick the composition rule whose category prefix best matches the findings."""
    flagged = {c.id for v in verdicts for c in v.categories}
    best, best_len = composition.get("default", {"strategy": "deny-wins"}), -1
    for prefix, rule in composition.items():
        if prefix in ("default", "conflict_default"):
            continue
        base = prefix.rstrip("*").rstrip(".")
        if any(cid == base or cid.startswith(base + ".") or base == "" for cid in flagged):
            if len(base) > best_len:
                best, best_len = rule, len(base)
    return best
