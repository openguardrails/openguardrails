"""OGR runtime — the Policy Decision Point.

Ingests GuardEvents, propagates provenance, correlates by guard_id across
observation points, fans out to detectors, composes one effective verdict.
"""
from __future__ import annotations

from .composition import compose, select_rule
from .detectors import Detector
from .models import GuardEvent, Verdict, severity


class Runtime:
    def __init__(self, detectors: list[Detector], policy: dict):
        self.detectors = detectors
        self.composition = policy.get("composition", {})
        self._events: dict[str, GuardEvent] = {}          # event_id -> event
        self._by_guard: dict[str, Verdict] = {}           # guard_id -> effective verdict so far

    # -- provenance propagation -----------------------------------------
    def _enrich(self, ev: GuardEvent) -> GuardEvent:
        """Inherit provenance from referenced prior events (spec: derived actions
        inherit the union of their source context's provenance)."""
        for ref in ev.context_refs:
            prior = self._events.get(ref)
            if prior:
                ev.provenance.extend(prior.provenance)
        return ev

    # -- main entry point -----------------------------------------------
    def evaluate(self, ev: GuardEvent) -> Verdict:
        self._enrich(ev)
        self._events[ev.event_id] = ev

        verdicts = [d.evaluate(ev) for d in self.detectors if d.applies_to(ev)]
        rule = select_rule(verdicts, self.composition)
        effective = compose(ev, verdicts, rule)

        # guard_id correlation: an altitude can only tighten a prior decision.
        prior = self._by_guard.get(ev.guard_id)
        if prior and severity(prior.decision) < severity(effective.decision):
            effective.decision = prior.decision
            effective.reasons.append(f"[correlation] tightened to prior decision "
                                     f"'{prior.decision}' from earlier observation point")
        self._by_guard[ev.guard_id] = effective
        return effective
