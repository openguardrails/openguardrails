"""GatewayEngine — build the OGR runtime and decide on a normalized request.

Protocol parsing lives in `protocols/`; this module is protocol-agnostic. It
turns a normalized request into `GuardEvent`s (observation_point="gateway"),
runs them through the shared `openguardrails` runtime, and returns one
`GatewayDecision` the server acts on.
"""
from __future__ import annotations

import itertools
import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from openguardrails import GuardEvent, Provenance, Runtime, Verdict
from openguardrails.detectors.config_rules import ConfigRulesDetector
from openguardrails.detectors.llm_judge import LLMJudgeDetector
from openguardrails.models import severity

from .detectors import ContentGuardDetector, find_secrets

DEFAULT_POLICY = Path(__file__).resolve().parent.parent / "policy.json"

# Map a message role to (trust, taint_tags). A gateway serves callers it does not
# fully trust, so `user` is "unverified"; tool/function output is "untrusted".
ROLE_PROVENANCE: dict[str, tuple[str, list[str]]] = {
    "system": ("trusted", []),
    "developer": ("trusted", []),
    "user": ("unverified", []),
    "assistant": ("model", []),
    "tool": ("untrusted", ["tool_result"]),
    "function": ("untrusted", ["tool_result"]),
}

_seq = itertools.count(1)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _id(prefix: str) -> str:
    return f"{prefix}-{next(_seq):04d}"


@dataclass
class GatewayDecision:
    decision: str                       # allow | modify | redact | require_approval | block
    verdicts: list[Verdict] = field(default_factory=list)
    redactions: list[dict] = field(default_factory=list)  # [{label, match}]
    guard_id: str = ""

    @property
    def allowed(self) -> bool:
        # redact/modify still forward upstream — after the engine applies edits.
        return self.decision in ("allow", "modify", "redact")

    def reason_summary(self) -> list[str]:
        out: list[str] = []
        for v in self.verdicts:
            if v.decision != "allow":
                out.extend(f"[{v.provider}] {r}" for r in v.reasons)
        return out


def load_policy(path: str | os.PathLike[str] | None = None) -> dict:
    p = Path(path or os.environ.get("OGR_GATEWAY_POLICY", DEFAULT_POLICY))
    return json.loads(p.read_text())


class GatewayEngine:
    def __init__(self, policy: dict | None = None):
        self.policy = policy or load_policy()
        # The gateway composes three reference detectors behind the one contract:
        #   - ContentGuardDetector : the gateway's own plane (messages, completion)
        #   - ConfigRulesDetector  : reused verbatim from core — judges tool_calls
        #   - LLMJudgeDetector     : provenance-aware model judge (offline by default)
        # Detectors are stateless and shared; the Runtime carries per-action
        # correlation state, so we mint a fresh one per request (no cross-request
        # bleed, no unbounded growth on a long-running server).
        self.detectors = [
            ContentGuardDetector(self.policy.get("content_rules", {})),
            ConfigRulesDetector(self.policy.get("config_rules", {})),
            LLMJudgeDetector(),
        ]

    def _runtime(self) -> Runtime:
        return Runtime(detectors=self.detectors, policy=self.policy)

    # -- request inspection --------------------------------------------
    def inspect_request(self, norm: dict[str, Any]) -> GatewayDecision:
        """norm = {protocol, model, messages:[{role,content,tool_calls?}], tools?}"""
        rt = self._runtime()
        guard_id = _id("gw")
        session_id = norm.get("session_id") or _id("sess")
        verdicts: list[Verdict] = []

        # 1) the prompt on the wire — one model_input event
        msgs, provenance = [], []
        for m in norm.get("messages", []):
            trust, taint = ROLE_PROVENANCE.get(m.get("role", "user"), ("unverified", []))
            text = _content_text(m.get("content"))
            msgs.append({"role": m.get("role"), "trust": trust, "content": text})
            provenance.append(Provenance(source=m.get("role", "user"), trust=trust,
                                         taint_tags=list(taint)))
        verdicts.append(rt.evaluate(GuardEvent(
            kind="model_input", observation_point="gateway",
            subject={"caller": norm.get("caller", "anonymous"), "model": norm.get("model")},
            payload={"messages": msgs, "model": norm.get("model")},
            event_id=_id("evt"), guard_id=guard_id, timestamp=_now(),
            session_id=session_id, llm_protocol=norm.get("protocol"),
            provenance=provenance,
        )))

        # 2) any tool_call carried in the request — same events the agent hook emits,
        #    so the SAME ConfigRules/LLMJudge detectors light up at the gateway.
        for tc in _tool_calls(norm):
            verdicts.append(rt.evaluate(GuardEvent(
                kind="tool_call", observation_point="gateway",
                subject={"caller": norm.get("caller", "anonymous")},
                payload={"name": tc["name"], "arguments": tc["arguments"]},
                event_id=_id("evt"), guard_id=guard_id, timestamp=_now(),
                session_id=session_id, llm_protocol=norm.get("protocol"),
                # tool calls proposed off the back of the prompt inherit its provenance
                context_refs=[],
                provenance=[Provenance(source="model", trust="unverified")],
            )))

        redactions = [s for m in msgs for s in find_secrets(m["content"])]
        return self._decide(guard_id, verdicts, redactions)

    # -- response inspection -------------------------------------------
    def inspect_response(self, text: str, *, protocol: str | None = None,
                         guard_id: str | None = None) -> GatewayDecision:
        gid = guard_id or _id("gw")
        rt = self._runtime()
        v = rt.evaluate(GuardEvent(
            kind="model_output", observation_point="gateway",
            subject={}, payload={"text": text},
            event_id=_id("evt"), guard_id=gid, timestamp=_now(),
            llm_protocol=protocol,
            provenance=[Provenance(source="model", trust="model")],
        ))
        return self._decide(gid, [v], find_secrets(text))

    # -- shared ---------------------------------------------------------
    def _decide(self, guard_id: str, verdicts: list[Verdict],
                redactions: list[dict] | None = None) -> GatewayDecision:
        effective = "allow"
        for v in verdicts:
            if severity(v.decision) < severity(effective):
                effective = v.decision
        return GatewayDecision(decision=effective, verdicts=verdicts,
                               redactions=redactions or [], guard_id=guard_id)


def apply_redactions(text: str, redactions: list[dict]) -> str:
    for r in redactions:
        text = text.replace(r["match"], f"[REDACTED:{r['label']}]")
    return text


def _content_text(content: Any) -> str:
    """OpenAI/Anthropic content can be a string or a list of typed parts."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, dict):
                parts.append(p.get("text") or p.get("content") or "")
            else:
                parts.append(str(p))
        return "\n".join(parts)
    return "" if content is None else str(content)


def _tool_calls(norm: dict[str, Any]) -> list[dict]:
    """Extract any tool/function calls embedded in assistant messages."""
    out: list[dict] = []
    for m in norm.get("messages", []):
        for tc in m.get("tool_calls", []) or []:
            fn = tc.get("function", tc)
            name = fn.get("name", "")
            args = fn.get("arguments", {})
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except (ValueError, TypeError):
                    args = {"_raw": args}
            out.append({"name": name, "arguments": args})
    return out
