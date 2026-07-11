"""Gateway-altitude reference detector — the message-content plane.

The agent-hook and sandbox altitudes see *actions* (tool calls, execs). The
gateway is the only altitude that sees the **raw LLM protocol**: the system /
user / tool messages on the way in, and the completion on the way out. So it is
where prompt-injection and secret/PII leakage are judged.

This is an ordinary OGR `Detector`: it accepts a `GuardEvent` and returns a
`Verdict`. A security vendor would replace or compose alongside it without the
gateway changing — that is the whole point of the contract.
"""
from __future__ import annotations

import re
import time

from openguardrails.detectors import Detector
from openguardrails.models import Category, GuardEvent, Verdict, severity

# Trust labels that mean "the gateway did not author this text".
_RISKY_TRUST = {"untrusted", "unverified"}

INJECTION_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"ignore\s+(all|any|the)?\s*(previous|prior|above)\s+(instructions|prompts?)", re.I),
     "instruction-override"),
    (re.compile(r"disregard\s+(the\s+)?(system|above)\s+(prompt|instructions)", re.I),
     "system-prompt-override"),
    (re.compile(r"\byou\s+are\s+now\b.*\b(DAN|jailbreak|developer\s+mode)\b", re.I),
     "jailbreak-roleswap"),
    (re.compile(r"(reveal|print|repeat)\s+(your|the)\s+(system\s+)?(prompt|instructions)", re.I),
     "system-prompt-exfil"),
]

# Secret / credential shapes. Matches feed redaction spans, not just a boolean.
SECRET_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"sk-[A-Za-z0-9_-]{20,}"), "openai-api-key"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "aws-access-key-id"),
    (re.compile(r"ghp_[A-Za-z0-9]{36}"), "github-token"),
    (re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"), "slack-token"),
    (re.compile(r"-----BEGIN (?:RSA |EC )?PRIVATE KEY-----"), "private-key"),
]


def find_secrets(text: str) -> list[dict]:
    """Return [{label, match}] for every credential shape in `text`.

    Shared by the detector (to decide) and the engine (to compute the spans to
    mask) — composition collapses a detector's evidence, so redaction spans are
    recomputed from this single source of patterns rather than smuggled through.
    """
    out: list[dict] = []
    for rx, label in SECRET_PATTERNS:
        for m in rx.finditer(text or ""):
            out.append({"label": label, "match": m.group(0)})
    return out


class ContentGuardDetector(Detector):
    """Inspects model_input / model_output text for injection and secret leakage."""

    provider = "ogr.gateway.content_guard"
    handles = ("model_input", "model_output")

    def __init__(self, config: dict | None = None):
        cfg = config or {}
        self.redact_secrets: bool = cfg.get("redact_secrets", True)
        self.injection_untrusted: str = cfg.get("injection_from_untrusted", "block")
        self.injection_unverified: str = cfg.get("injection_from_unverified", "require_approval")

    # -- helpers --------------------------------------------------------
    def _segments(self, ev: GuardEvent) -> list[tuple[str, str]]:
        """Return (trust, text) pairs to scan."""
        if ev.kind == "model_input":
            return [(m.get("trust", "unverified"), m.get("content", "") or "")
                    for m in ev.payload.get("messages", [])]
        # model_output — the completion is authored by the model
        return [("model", ev.payload.get("text", "") or "")]

    # -- main -----------------------------------------------------------
    def evaluate(self, ev: GuardEvent) -> Verdict:
        t0 = time.perf_counter()
        cats: list[Category] = []
        reasons: list[str] = []
        evidence: list[dict] = []
        decision = "allow"

        for trust, text in self._segments(ev):
            if not text:
                continue

            # --- prompt injection (only meaningful from non-self-authored text) ---
            if trust in _RISKY_TRUST:
                for rx, label in INJECTION_PATTERNS:
                    if rx.search(text):
                        want = (self.injection_untrusted if trust == "untrusted"
                                else self.injection_unverified)
                        decision = _tighten(decision, want)
                        cats.append(Category("security.prompt_injection", "security", 0.92))
                        reasons.append(f"injection pattern '{label}' in {trust} content")

            # --- secret / credential leakage (any segment, in or out) ---
            for hit in find_secrets(text):
                decision = _tighten(decision, "redact" if self.redact_secrets else "block")
                cats.append(Category("security.secret_leak", "security", 0.95))
                reasons.append(f"{hit['label']} present in {trust} text")
                evidence.append({"type": "redact", **hit})

        v = Verdict(ev.event_id, ev.guard_id, self.provider, decision,
                    categories=cats, reasons=reasons or ["no content finding"],
                    evidence=evidence)
        v.latency_ms = round((time.perf_counter() - t0) * 1000, 3)
        return v


def _tighten(current: str, candidate: str) -> str:
    """Return whichever decision is more severe (lower severity index)."""
    return current if severity(current) <= severity(candidate) else candidate
