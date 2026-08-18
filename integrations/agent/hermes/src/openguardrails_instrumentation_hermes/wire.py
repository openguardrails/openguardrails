"""The OGR v0.8 wire, hand-rolled.

There is no SDK layer — the Runtime API is the integration surface
(specification/runtime-api.md), and an integration is one decision endpoint:
POST /v1/evaluate while holding an action, plus the optional /v1/heartbeat
for liveness. This module is those two calls over stdlib urllib and the
config they need, nothing else: no enrollment, no signing, no batching
thread, no client-side decomposition (all of it left the protocol with the
SDK layer; /v1/ingest itself was removed in v0.8 — evaluate records).

The base URL is joined with the canonical `/v1/...` paths exactly as the
binding requires — a deployment-specific prefix belongs IN the configured
base URL (`https://host/api/public/ogr`), never hard-coded here.
"""
from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from typing import Any

logger = logging.getLogger("ogr-guard.wire")

# Kept in sync with pyproject.toml. Lives on the HEARTBEAT, not on events —
# the build id left the GuardEvent in v0.8; fleet coverage reads it here.
VERSION = "1.0.0"
INTEGRATION = f"openguardrails-instrumentation-hermes/{VERSION}"

# Short and deliberately a hook-path budget, not a model-call budget: every
# evaluate sits between the agent and its next action, so a stalled runtime
# must resolve fast — into the configured fail mode — rather than freeze
# Hermes. Override with OGR_TIMEOUT (seconds).
_DEFAULT_TIMEOUT = 4.0


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


class OgrClient:
    """The one-endpoint client. Explicit kwargs override the environment:

    OGR_RUNTIME_URL       runtime base URL (unset = no runtime; fail mode decides)
    OGR_API_KEY           organization API key (Authorization: Bearer)
    OGR_AGENT_ID          the four-tuple; all default "" — the explicit
    OGR_AGENT_TYPE          "no assertion", identity then derives from the
    OGR_AGENT_WORKSPACE     API key (the identity floor). agent_type defaults
    OGR_AGENT_USER          to "hermes": the one field this integration DOES
                            know about itself (a label, never an identity).
    OGR_FAIL_MODE         open (default) | closed — what an unanswered
                          evaluate means (specification/degraded-mode.md)
    OGR_TIMEOUT           per-call budget in seconds, default 4.0
    """

    def __init__(
        self,
        *,
        runtime_url: str | None = None,
        api_key: str | None = None,
        agent_id: str | None = None,
        agent_type: str | None = None,
        agent_workspace: str | None = None,
        agent_user: str | None = None,
        fail_mode: str | None = None,
        timeout: float | None = None,
    ) -> None:
        self.runtime_url = (runtime_url if runtime_url is not None
                            else _env("OGR_RUNTIME_URL")).rstrip("/")
        self.api_key = api_key if api_key is not None else _env("OGR_API_KEY")
        # All four always present on every event; "" is a value (the explicit
        # "no assertion"), never an omission — the schema has zero optional fields.
        self.identity: dict[str, str] = {
            "agent_id": agent_id if agent_id is not None else _env("OGR_AGENT_ID"),
            "agent_type": (agent_type if agent_type is not None
                           else _env("OGR_AGENT_TYPE") or "hermes"),
            "agent_workspace": (agent_workspace if agent_workspace is not None
                                else _env("OGR_AGENT_WORKSPACE")),
            "agent_user": agent_user if agent_user is not None else _env("OGR_AGENT_USER"),
        }
        mode = (fail_mode if fail_mode is not None else _env("OGR_FAIL_MODE")).lower() or "open"
        if mode not in ("open", "closed"):
            # A deployment that touched this knob wanted MORE than the default;
            # rounding a typo down to open would silently remove the protection
            # it asked for. The unrecognized value degrades to closed, loudly.
            logger.warning("OGR_FAIL_MODE=%r not recognized — treating as 'closed'", mode)
            mode = "closed"
        self.fail_mode = mode
        try:
            self.timeout = timeout if timeout is not None \
                else float(_env("OGR_TIMEOUT") or _DEFAULT_TIMEOUT)
        except ValueError:
            self.timeout = _DEFAULT_TIMEOUT
        # Heartbeat counters (degraded-mode §2: loud signaling — the
        # evaluate_errors counter is how the runtime learns a PEP went dark).
        self.counters = {"events_sent": 0, "evaluate_errors": 0}

    @property
    def enabled(self) -> bool:
        """Whether a runtime is configured at all. When it is not, every
        evaluate returns None and the FAIL MODE decides — under the default
        (open) the plugin is a pass-through, under closed it denies, which is
        the honest reading of "gate this and the gate is not there"."""
        return bool(self.runtime_url and self.api_key)

    # ------------------------------------------------------------------ #
    # transport
    # ------------------------------------------------------------------ #
    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any] | None:
        """POST one JSON body; parsed JSON on 2xx, None on ANY failure.
        Never raises: this runs inside Hermes' hook path, and a guard that
        can crash the agent it guards would never be adopted."""
        # default=str: the payload is whatever Hermes handed the hook, and a
        # stray non-JSON fragment must degrade to its string form, not take
        # the whole event (and the hook) down with a TypeError.
        data = json.dumps(body, default=str).encode("utf-8")
        req = urllib.request.Request(
            f"{self.runtime_url}{path}",
            data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    # ------------------------------------------------------------------ #
    # the protocol
    # ------------------------------------------------------------------ #
    def evaluate(self, kind: str, step_id: str, llm_protocol: str,
                 payload: dict[str, Any]) -> dict[str, Any] | None:
        """Judge ONE event; the Verdict dict, or None when the runtime could
        not answer (unconfigured, timeout, 401/429/5xx, network, bad JSON).
        Deciding what None means is `blocked()`'s job — that is the
        deployment's fail mode, and the degraded-mode spec is explicit that a
        429 is an outage, not an allow."""
        if not self.enabled:
            return None
        event = {
            "kind": kind,
            "step_id": step_id,
            **self.identity,
            "llm_protocol": llm_protocol,
            "payload": payload,
            # WHO REPORTED IT — the one OPTIONAL v0.8 field. The SAME constant the
            # heartbeat sends: two literals would drift and each would look right.
            #
            # It rode the heartbeat alone until 2026-08-17, which could not answer
            # "which build produced this traffic": a runtime keys its liveness record
            # on the integration NAME (it must, so a rollout updates that row rather
            # than minting a second and reporting the old build as dark), so every
            # replica overwrites the others' version.
            "integration": INTEGRATION,
        }
        try:
            verdict = self._post("/v1/evaluate", event)
        except Exception as exc:  # noqa: BLE001 — every failure is one outcome: no verdict
            self.counters["evaluate_errors"] += 1
            logger.warning("OGR evaluate failed (%s) — no verdict, fail-%s applies",
                           exc, self.fail_mode)
            return None
        self.counters["events_sent"] += 1
        return verdict

    def blocked(self, verdict: dict[str, Any] | None) -> bool:
        """The enforcement question, fail-mode aware.

        Three sizes of "could not look", all governed by the one fail_mode
        (degraded-mode spec): no verdict at all, and a verdict whose
        `unjudged` names paths this event carried. Under the default (open)
        only an explicit block stops the agent; under closed, unprotected
        equals denied.
        """
        if verdict is None:
            return self.fail_mode == "closed"
        if verdict.get("decision") == "block":
            return True
        if self.fail_mode == "closed" and verdict.get("unjudged"):
            # "Could not look" is not "found nothing" — the one assertion a
            # fail-closed deployment rests on is an absent/empty unjudged.
            return True
        return False

    def heartbeat(self) -> bool:
        """Fire-and-forget liveness: lets the runtime tell "agent idle" from
        "integration went dark", and carries the build id + error counters
        (the observability gap an outage causes is visible here, since v0.8
        has no replay channel). Never required, never raises."""
        if not self.enabled:
            return False
        body: dict[str, Any] = {"integration": INTEGRATION, "counters": dict(self.counters)}
        if self.identity["agent_id"]:
            body["agent_id"] = self.identity["agent_id"]
        try:
            self._post("/v1/heartbeat", body)
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("OGR heartbeat failed (%s)", exc)
            return False
