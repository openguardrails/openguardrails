"""Client for the OpenGuardrails runtime PDP (POST /api/public/ogr/v1/evaluate).

The addon is a Policy Enforcement Point (PEP): it observes the LLM wire protocol
and asks the runtime (the PDP) for a Verdict on each GuardEvent. This module is a
dependency-light (stdlib only) blocking client; the addon calls `evaluate` in an
executor so the mitmproxy event loop never blocks.

Protocol: OGR 0.3 — GuardEvent in, Verdict out. See
https://github.com/openguardrails/openguardrails/tree/main/schema
"""
from __future__ import annotations

import itertools
import json
import secrets
import urllib.error
import urllib.request
from datetime import datetime, timezone

OGR_VERSION = "0.3"
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
    """Build a GuardEvent (observation_point='gateway'). `subject` may be empty:
    when the operator does not force an agent identity, the runtime derives the
    Agent from the request's system-prompt self-definition at ingest. `payload`
    is kind-specific (user_input/model_output -> {"text": ...}; tool_call ->
    {"name","arguments"}).

    `authz` is the runtime's reasoning-blind authorization envelope
    (transcript / agent_system_prompt / authorization) that scope-aware
    guardrails such as `yolo` consume. It rides on guardEventExtSchema, an
    additive runtime extension off the OGR wire GuardEvent."""
    event = {
        "ogr_version": OGR_VERSION,
        "event_id": new_id("evt"),
        "guard_id": guard_id or new_id("gw"),
        "session_id": session_id,
        "timestamp": _now(),
        "observation_point": "gateway",
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
    """Thin PDP client. `evaluate` is blocking; run it off the event loop."""

    def __init__(self, base_url: str, api_key: str, timeout: float = 2.0):
        self.endpoint = base_url.rstrip("/") + "/api/public/ogr/v1/evaluate"
        self.api_key = api_key
        self.timeout = timeout

    def evaluate(self, event: dict) -> dict:
        """POST one GuardEvent, return the Verdict dict. Raises on transport or
        non-2xx (the caller maps that to its fail mode)."""
        data = json.dumps(event).encode("utf-8")
        req = urllib.request.Request(
            self.endpoint, data=data, method="POST",
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {self.api_key}",
            },
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
