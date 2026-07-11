"""LangGraph-free core of the binding — the agent-hook decision logic.

A LangGraph developer runs their tools inside a node (a ``ToolNode``). That node
boundary is OGR's **agent-hook altitude**: the Policy Enforcement Point where a
``tool_call`` is judged before it executes. This module turns a tool call into an
OGR ``GuardEvent``, runs it through the reference ``Runtime`` (the PDP) with the
two bundled detectors, and returns a plain ``ToolDecision`` — no ``langgraph``
import, so it is testable offline exactly like the litellm binding's ``_engine``.

Provenance / taint (spec: provenance-and-context.md): tools whose *results* pull
external content into the agent's context (web fetch, retrieval, MCP) taint the
session; a later tool call inherits that untrusted provenance, so the SAME
command gets a different verdict depending on where its inputs came from. This is
the indirect-prompt-injection defense — identical in shape to the OpenClaw
plugin's channel-inbound tainting, just expressed over LangGraph state.
"""
from __future__ import annotations

import itertools
import json
import os
import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from openguardrails import GuardEvent, Provenance, Runtime, load_policy
from openguardrails.detectors.config_rules import ConfigRulesDetector
from openguardrails.detectors.llm_judge import LLMJudgeDetector

DEFAULT_POLICY = Path(__file__).resolve().parent / "policy.json"

# Non-blocking verdicts — the action proceeds (possibly rewritten). Anything
# else (block) stops the tool; require_approval is handled specially (interrupt).
_ALLOW_DECISIONS = {"allow", "modify", "redact"}

# Tool names whose *results* introduce untrusted content into the agent context.
# Override per-deployment via policy `config_rules.untrusted_result_tools` or the
# `untrusted_result_tools=` kwarg on the ToolNode.
_DEFAULT_UNTRUSTED_RESULT_TOOLS = {
    "web_search", "web_fetch", "fetch_url", "read_url", "browser",
    "tavily_search", "tavily", "retriever", "retrieve", "search", "mcp",
}

_seq = itertools.count(1)
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _id(prefix: str) -> str:
    with _lock:
        return f"{prefix}-{next(_seq):04d}"


@dataclass
class ToolDecision:
    """The engine's answer for one tool call — the binding acts on this."""

    decision: str
    reasons: list[str] = field(default_factory=list)
    categories: list[str] = field(default_factory=list)
    untrusted: bool = False

    def allowed(self) -> bool:
        return self.decision in _ALLOW_DECISIONS

    def needs_approval(self) -> bool:
        return self.decision == "require_approval"

    def blocked(self) -> bool:
        return not self.allowed() and not self.needs_approval()

    def brief(self) -> str:
        cats = ", ".join(self.categories) or "—"
        why = "; ".join(self.reasons) if self.reasons else ""
        head = f"[OGR:{self.decision}] {cats}"
        return f"{head} — {why}" if why else head


class GuardEngine:
    """Holds one Runtime + one policy and the per-session taint ledger.

    The engine is the reusable, framework-free heart of every LangGraph binding
    surface (ToolNode, ``guard()``, ``@ogr_guard``) — they differ only in how
    they *enforce* the ToolDecision this returns.
    """

    def __init__(self, policy: dict):
        self.policy = policy
        cfg = policy.get("config_rules", {})
        self.runtime = Runtime(
            detectors=[ConfigRulesDetector(cfg), LLMJudgeDetector()],
            policy=policy,
        )
        self.untrusted_result_tools = set(
            cfg.get("untrusted_result_tools", _DEFAULT_UNTRUSTED_RESULT_TOOLS)
        )
        self._taint: dict[str, list[Provenance]] = {}

    # -- provenance -----------------------------------------------------
    def _provenance_for(self, session_id: str | None) -> list[Provenance]:
        prov = [Provenance("user", "trusted")]
        if session_id:
            prov.extend(self._taint.get(session_id, []))
        return prov

    def taint_session(self, session_id: str | None, source: str = "tool_result") -> None:
        """Mark a session as having ingested untrusted external content, so
        subsequent tool calls in that session inherit untrusted provenance."""
        if not session_id:
            return
        src = source if source in {"web", "mcp", "tool_result", "file", "retrieved"} else "tool_result"
        prov = Provenance(
            src, "untrusted", ref=_id("evt"),
            taint_tags=["external_content", "executable_intent"],
        )
        with _lock:
            self._taint.setdefault(session_id, []).append(prov)

    def taints_context(self, tool_name: str) -> bool:
        return tool_name in self.untrusted_result_tools

    # -- the one call bindings make -------------------------------------
    def evaluate_tool_call(
        self,
        name: str,
        args,
        *,
        session_id: str | None = None,
        agent_id: str = "langgraph",
        extra_provenance: list[Provenance] | None = None,
    ) -> ToolDecision:
        provenance = self._provenance_for(session_id)
        if extra_provenance:
            provenance.extend(extra_provenance)
        ev = GuardEvent(
            kind="tool_call",
            observation_point="agent_hook",
            subject={"agent_id": agent_id, "agent_type": "langgraph", "principal": "user"},
            payload={"name": name, "arguments": args if isinstance(args, dict) else {"input": args}},
            event_id=_id("evt"),
            guard_id=_id("ga"),
            timestamp=_now(),
            session_id=session_id,
            provenance=provenance,
        )
        v = self.runtime.evaluate(ev)
        return ToolDecision(
            decision=v.decision,
            reasons=list(v.reasons),
            categories=[c.id for c in v.categories],
            untrusted=ev.is_untrusted(),
        )


def build_engine(policy_path: str | os.PathLike | dict | None = None) -> GuardEngine:
    """Build the engine from a policy path (default: bundled overlay resolving
    `openguardrails:base`), an ``OGR_POLICY`` env override, or a ready dict."""
    if isinstance(policy_path, dict):
        return GuardEngine(policy_path)
    path = policy_path or os.environ.get("OGR_POLICY") or DEFAULT_POLICY
    # The bundled overlay is `$extends: "openguardrails:base"`; load_policy
    # resolves the base and deep-merges it into one effective policy.
    return GuardEngine(load_policy(path))


__all__ = ["GuardEngine", "ToolDecision", "build_engine"]
