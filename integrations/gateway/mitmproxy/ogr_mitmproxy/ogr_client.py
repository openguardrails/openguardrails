"""Client for the OpenGuardrails runtime PDP (POST /v1/evaluate).

The addon is a Policy Enforcement Point (PEP): it observes the LLM wire protocol
and asks the runtime (the PDP) for a Verdict on each GuardEvent. Transport is
the core SDK's `RuntimeClient` (canonical `/v1/*` paths, with an automatic
fallback to the legacy `/api/public/ogr` mount); `evaluate` is blocking, so the
addon calls it in an executor and the mitmproxy event loop never blocks.

Protocol: OGR 0.3 — GuardEvent in, Verdict out. See
https://github.com/openguardrails/openguardrails/tree/main/schema
"""
from __future__ import annotations

import itertools
import secrets
from datetime import datetime, timezone

from openguardrails import RuntimeClient

OGR_VERSION = "0.5"
_seq = itertools.count(1)
# Per-process tag folded into every generated id. A bare counter reuses
# evt-/gw-/session-/run- ids after a gateway restart, and the runtime's
# analytics store treats a reused event id as a NEWER VERSION of the old row —
# a restart then silently overwrites historical events. The tag makes ids from
# different gateway processes disjoint while keeping them readable/sortable.
_proc_tag = secrets.token_hex(4)


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_id(prefix: str) -> str:
    return f"{prefix}-{_proc_tag}-{next(_seq):06d}"


def make_event(kind: str, *, subject: dict, payload: dict, session_id: str,
               guard_id: str | None = None, llm_protocol: str | None = None,
               provenance: list[dict] | None = None,
               authz: dict | None = None, run_id: str | None = None,
               turn: int | None = None) -> dict:
    """Build a GuardEvent (observation_point='conversation'). `subject` may be empty:
    when the operator asserts no agent identity, the runtime falls back to the
    identity floor — the agent is derived from the API key (one key, one default
    agent) and every session is attributed to one user. `payload` is
    kind-specific (user_input/model_output -> {"text": ...}; tool_call ->
    {"name","arguments"}).

    `authz` is the runtime's reasoning-blind authorization envelope
    (transcript / agent_system_prompt / authorization) that scope-aware
    guardrails such as `yolo` consume. It rides on guardEventExtSchema, an
    additive runtime extension off the OGR wire GuardEvent — the SDK's dict
    passthrough (`event_to_wire`) keeps it, and `run_id`/`turn`, on the wire."""
    event = {
        "ogr_version": OGR_VERSION,
        "event_id": new_id("evt"),
        "guard_id": guard_id or new_id("gw"),
        "session_id": session_id,
        "timestamp": _now(),
        "observation_point": "conversation",
        # proxy class: an agent that talks to a different endpoint is never
        # seen here at all — evadable from outside the process, not from in it.
        "sensor": {"id": "openguardrails-mitmproxy", "class": "proxy"},
        "kind": kind,
        "subject": subject,
        "payload": payload,
    }
    if llm_protocol:
        event["llm_protocol"] = llm_protocol
    if provenance:
        event["provenance"] = provenance
    if authz:
        event["authz"] = authz
    if run_id:
        event["run_id"] = run_id
        event["turn"] = max(int(turn or 0), 0)
    return event


class OGRClient:
    """Thin PDP client over the SDK. `evaluate` is blocking; run it off the
    event loop. `identity` (an enrolled PepIdentity) signs every request body
    so the runtime can raise this channel's attestation ceiling
    (specification/attestation.md)."""

    def __init__(self, base_url: str, api_key: str, timeout: float = 2.0,
                 identity=None):
        self.identity = identity
        # An empty api_key keeps the addon constructible (it warns and lets
        # every evaluate fail into the configured fail mode, as before).
        self._client = (RuntimeClient(base_url, api_key, timeout=timeout,
                                      signer=identity)
                        if api_key else None)

    def evaluate(self, event: dict) -> dict:
        """POST one GuardEvent, return the Verdict dict. Raises on transport or
        non-2xx (the caller maps that to its fail mode)."""
        if self._client is None:
            raise RuntimeError("OGR_API_KEY is not set")
        verdict = self._client.evaluate(event)
        # Callers consume the wire dict (decision/reasons plus runtime
        # extension keys such as `suggest_answer`), not the SDK dataclass.
        wire = {k: v for k, v in verdict.to_dict().items()
                if v is not None and v != []}
        wire.update(getattr(verdict, "extensions", {}))
        return wire
