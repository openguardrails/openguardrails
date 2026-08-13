"""OGR runtime — the Policy Decision Point.

Ingests GuardEvents, propagates provenance, correlates by guard_id across
observation points, fans out to detectors, composes one effective verdict.
"""
from __future__ import annotations

import secrets
import time

from .composition import compose, select_rule
from .detectors import Detector
from .llm_derive import derive_llm_event
from .models import GuardEvent, Verdict, severity


class Runtime:
    def __init__(self, detectors: list[Detector], policy: dict):
        self.detectors = detectors
        self.composition = policy.get("composition", {})
        self._by_guard: dict[str, Verdict] = {}           # guard_id -> effective verdict so far

    # -- main entry point -----------------------------------------------
    def evaluate(self, ev: GuardEvent) -> Verdict:
        # OGR v0.6: identifiers are born at the runtime, and raw provider
        # bodies (llm_request/llm_response) are classified here — the PDP's
        # job, wherever the PDP runs.
        derive_llm_event(ev)
        if not ev.event_id:
            ev.event_id = f"evt-{int(time.time() * 1000):x}-{secrets.token_hex(6)}"
        if not ev.guard_id:
            ev.guard_id = ev.event_id

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
