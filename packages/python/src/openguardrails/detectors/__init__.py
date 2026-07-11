"""Detector plugin interface.

A detector is OGR-conformant if it accepts a GuardEvent and returns a Verdict.
This is the surface security/safety vendors implement and compete behind. The
PoC ships two reference detectors — one config-based, one LLM-based.
"""
from __future__ import annotations

from ..models import GuardEvent, Verdict


class Detector:
    #: stable identity used for attribution / metering / benchmark
    provider: str = "ogr.detector"
    #: kinds this detector handles; empty == all kinds
    handles: tuple[str, ...] = ()

    def evaluate(self, ev: GuardEvent) -> Verdict:  # pragma: no cover - interface
        raise NotImplementedError

    def applies_to(self, ev: GuardEvent) -> bool:
        return not self.handles or ev.kind in self.handles
