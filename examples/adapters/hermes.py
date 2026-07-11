"""Hermes ↔ OGR adapters.

Two integration points, both speaking the OGR protocol to one Runtime:

  HermesAgentGuard  — wraps the agent loop's tool dispatch (maps to Hermes'
                      pre-tool hook). Mints the guard_id and provenance.
  GuardedSandbox    — wraps the sandbox's exec (maps to srt/openshell exec
                      interception). Inherits guard-context, sees real argv/env.

The guard_id minted by the agent flows to the sandbox via `ogr-guardcontext`, so
both observation points decide on ONE correlated logical action.
"""
from __future__ import annotations

import itertools
from datetime import datetime, timezone

from openguardrails import GuardEvent, Provenance, Runtime, Verdict

_seq = itertools.count(1)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _id(prefix: str) -> str:
    return f"{prefix}-{next(_seq):04d}"


# -- guard-context propagation (spec: provenance-and-context.md) ----------
def encode_guardcontext(guard_id: str, session_id: str, prov_present: bool) -> str:
    # spec format: 01|<guard_id>|<session_id>|<flags>  (fields are opaque/URL-safe)
    flags = 1 if prov_present else 0
    return f"01|{guard_id}|{session_id}|{flags:02x}"


def decode_guardcontext(header: str) -> dict:
    _ver, guard_id, session_id, flags = header.split("|", 3)
    return {"guard_id": guard_id, "session_id": session_id,
            "prov_present": bool(int(flags, 16) & 1)}


class _Enforcer:
    def __init__(self, runtime: Runtime):
        self.rt = runtime

    def _enforce(self, ev: GuardEvent) -> tuple[bool, Verdict]:
        v = self.rt.evaluate(ev)
        allowed = v.decision in ("allow", "modify", "redact")
        return allowed, v


class HermesAgentGuard(_Enforcer):
    """Hermes pre-tool hook → OGR (observation_point=agent_hook)."""

    def __init__(self, runtime: Runtime, agent_id: str = "hermes-1", principal: str = "user:tom"):
        super().__init__(runtime)
        self.agent_id, self.principal = agent_id, principal

    def guard_tool_call(self, name: str, arguments: dict, session_id: str,
                        provenance: list[Provenance] | None = None,
                        context_refs: list[str] | None = None):
        guard_id = _id("ga")
        ev = GuardEvent(
            kind="tool_call", observation_point="agent_hook",
            subject={"agent_id": self.agent_id, "agent_type": "hermes",
                     "principal": self.principal},
            payload={"name": name, "arguments": arguments},
            event_id=_id("evt"), guard_id=guard_id, timestamp=_now(),
            session_id=session_id, provenance=provenance or [],
            context_refs=context_refs or [],
        )
        allowed, verdict = self._enforce(ev)
        gctx = encode_guardcontext(guard_id, session_id, bool(provenance))
        return allowed, verdict, gctx


class GuardedSandbox(_Enforcer):
    """Sandbox exec interception → OGR (observation_point=sandbox).

    Stand-in for srt/openshell: it does NOT actually run the process; it asks OGR
    first and only proceeds on allow. Inherits guard_id + provenance via the
    guard-context header so the sandbox judges 'bash with an untrusted origin'.
    """

    def __init__(self, runtime: Runtime, sandbox_id: str = "sbx-7"):
        super().__init__(runtime)
        self.sandbox_id = sandbox_id

    def exec(self, argv: list[str], guardcontext: str, cwd: str = "/workspace",
             env_keys: list[str] | None = None,
             inherited_provenance: list[Provenance] | None = None):
        ctx = decode_guardcontext(guardcontext)
        ev = GuardEvent(
            kind="exec", observation_point="sandbox",
            subject={"agent_id": "hermes-1", "agent_type": "hermes",
                     "sandbox_id": self.sandbox_id},
            payload={"argv": argv, "cwd": cwd, "env_keys": env_keys or []},
            event_id=_id("evt"), guard_id=ctx["guard_id"], timestamp=_now(),
            session_id=ctx["session_id"],
            provenance=inherited_provenance or [],
        )
        allowed, verdict = self._enforce(ev)
        return allowed, verdict
