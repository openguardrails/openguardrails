"""The OGR v0.8 wire, hand-rolled.

There is no SDK layer — the Runtime API is the integration surface
(``specification/runtime-api.md``), and an agent-direct integration is two
POSTs to ``/v1/evaluate`` per model call. This module is that one call plus
the optional heartbeat, over stdlib ``urllib``: no batching, no retries, no
client-side decomposition, no third-party HTTP dependency to pin.

The configured base URL is joined with the canonical ``/v1/...`` paths
exactly as the binding requires — a deployment-specific prefix belongs IN
the base URL (``https://host/api/public/ogr``), never hard-coded here.
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request

logger = logging.getLogger("openguardrails.langgraph")

# The build id. It left the GuardEvent in v0.8 and lives on the heartbeat,
# which is where fleet coverage and bad-rollout triage read it.
INTEGRATION = "ogr-langgraph/1.0.0"

DEFAULT_TIMEOUT_S = 5.0


class OgrClient:
    """The transport: where the runtime is, and as whom we authenticate.

    Identity (the four-tuple) and enforcement (fail mode) are the guard's
    business, not the transport's — one process may guard several agents
    through one client. Constructor arguments win over the environment
    (``OGR_RUNTIME_URL``, ``OGR_API_KEY``, ``OGR_TIMEOUT_S``).
    """

    def __init__(
        self,
        runtime_url: str | None = None,
        api_key: str | None = None,
        timeout: float | None = None,
    ) -> None:
        self.runtime_url = (runtime_url or os.environ.get("OGR_RUNTIME_URL", "")).rstrip("/")
        # A missing URL is a setup error, not an outage: fail_mode governs a
        # runtime that stops answering, never one that was never configured.
        if not self.runtime_url:
            raise ValueError(
                "OgrClient needs a runtime base URL (runtime_url= or OGR_RUNTIME_URL)"
            )
        self.api_key = api_key if api_key is not None else os.environ.get("OGR_API_KEY", "")
        self.timeout = float(
            timeout if timeout is not None else os.environ.get("OGR_TIMEOUT_S", DEFAULT_TIMEOUT_S)
        )
        # Degraded-mode visibility (degraded-mode.md § loud signaling): a
        # fail-open integration that goes dark must at least COUNT what it
        # lost. The heartbeat carries these to the runtime.
        self.events_sent = 0
        self.evaluate_errors = 0
        self.unresolved_spans = 0

    def _post(self, path: str, body: dict) -> dict:
        request = urllib.request.Request(
            self.runtime_url + path,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            return json.loads(response.read().decode("utf-8"))

    def evaluate(self, event: dict) -> dict | None:
        """Judge ONE GuardEvent and return its Verdict — or ``None`` when the
        runtime could not answer (timeout, 429, 4xx/5xx, network, bad JSON).

        Deciding what a missing verdict means is the CALLER's job: that is
        the deployment's fail mode, and the degraded-mode spec is explicit
        that a 429 is an outage, not an allow.
        """
        try:
            # WHO REPORTED IT — the one OPTIONAL v0.8 field, stamped HERE rather than
            # at each construction site: one send path means the build id cannot go
            # missing on one kind of event only. The SAME constant the heartbeat
            # sends, because two literals would drift and each would look right.
            verdict = self._post("/v1/evaluate", {**event, "integration": INTEGRATION})
            self.events_sent += 1
            return verdict
        except (OSError, ValueError) as err:  # URLError/HTTPError/timeout are OSError
            self.evaluate_errors += 1
            logger.warning("evaluate failed (%s) — no verdict", err)
            return None

    def heartbeat(self, agent_id: str = "", interval_s: float | None = None) -> bool:
        """Optional liveness ping, so the runtime can tell "agent idle" from
        "integration went dark". Fire-and-forget: a failed heartbeat is never
        a lost enforcement, so it warns and reports ``False``.
        """
        body: dict = {
            "integration": INTEGRATION,
            "counters": {
                "events_sent": self.events_sent,
                "evaluate_errors": self.evaluate_errors,
                "unresolved_spans": self.unresolved_spans,
            },
        }
        if agent_id:
            body["agent_id"] = agent_id
        if interval_s is not None:
            body["interval_s"] = interval_s
        try:
            self._post("/v1/heartbeat", body)
            return True
        except (OSError, ValueError) as err:
            logger.warning("heartbeat failed (%s)", err)
            return False
