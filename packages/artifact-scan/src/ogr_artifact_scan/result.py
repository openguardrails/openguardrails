"""WHAT CAME BACK — and the rule that nothing may manufacture a pass."""

from __future__ import annotations

from dataclasses import dataclass

#: The three-state verdict. A scanner is a DETECTOR: whether `suspicious` stops
#: the action is the calling policy's decision, never this client's.
VERDICTS = ("clean", "suspicious", "malicious")

#: What a PEP reports back on the next GuardEvent.
STATES = ("fulfilled", "failed", "skipped")


@dataclass
class ScanResult:
    state: str
    verdict: str = ""
    provider: str = ""
    analysis_id: str = ""
    detected_type: str = ""
    reason: str = ""

    @property
    def ok(self) -> bool:
        return self.state == "fulfilled"

    def to_obligation_result(self, obligation_id: str) -> dict:
        """The `obligation_results[]` entry for the next `step/request`.

        ⚠️ Empty fields are OMITTED, not sent as `""`. The schema marks them
        optional and a runtime distinguishes absent from empty; sending `""`
        would assert "the scanner answered, with nothing", which is a different
        claim from "it did not answer".
        """
        out = {"id": obligation_id, "state": self.state}
        for key in ("verdict", "provider", "analysis_id", "detected_type", "reason"):
            value = getattr(self, key)
            if value:
                out[key] = value
        return out


def failed(reason: str, detected_type: str = "") -> ScanResult:
    """⚠️ Every failure path lands HERE rather than raising.

    A scanner being down must leave a RECORD — "we asked and could not find
    out" — instead of an exception that retries into silence. The one outcome
    that must never be manufactured is `clean`: an unpolled `202`, a non-2xx, an
    unparseable body and a verdict outside `VERDICTS` are all failures, and
    converting any of them to a pass is the single error in this protocol that
    cannot be detected afterwards.
    """
    return ScanResult(state="failed", reason=reason[:512], detected_type=detected_type)


def skipped(reason: str, detected_type: str = "") -> ScanResult:
    """The caller CHOSE not to scan — a decision somebody made.

    ⚠️ Report it rather than staying silent. Silence and refusal are different
    facts, and a runtime counts silence as the gap in the control; letting a
    deliberate choice be counted as a gap makes the one number that matters
    unreadable.
    """
    return ScanResult(state="skipped", reason=reason[:512], detected_type=detected_type)
