"""The OGR v0.8 wire, hand-rolled.

There is no SDK layer — the Runtime API is the integration surface
(specification/runtime-api.md), and an integration is one endpoint hit twice
per model call: ``POST /v1/evaluate`` holding the request, ``POST
/v1/evaluate`` holding the response. This module is that call plus the
optional heartbeat, on nothing but the standard library (``urllib.request``):
no batching machinery, no client-side decomposition, no third-party HTTP
dependency.

The base URL is joined with the canonical ``/v1/...`` paths exactly as the
binding requires — a deployment-specific prefix belongs IN the configured
base URL (``https://host/api/public/ogr``), never hard-coded here.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request

__version__ = "0.1.0"

logger = logging.getLogger("openguardrails")

#: WHO REPORTED IT — ``"name/version"``, on every event AND on the heartbeat.
#: One constant so the two can never name different builds.
INTEGRATION = f"openguardrails-litellm/{__version__}"

#: The nine REQUIRED v0.8 GuardEvent fields, exactly as
#: schema/guard-event.schema.json requires them (additionalProperties: false —
#: nothing outside these plus :data:`OPTIONAL_EVENT_FIELDS` may ride along).
EVENT_FIELDS = (
    "kind",
    "step_id",
    "agent_id",
    "agent_type",
    "agent_workspace",
    "agent_user",
    "llm_protocol",
    "payload",
)

#: The one OPTIONAL field (2026-08-17). It rode the heartbeat ALONE until then,
#: which could not answer "which build produced this traffic": a runtime keys its
#: liveness record on the integration NAME — it must, so a rollout updates that row
#: instead of minting a second and reporting the old build as dark — so every
#: replica overwrites the others' version.
OPTIONAL_EVENT_FIELDS = ("integration",)


def _json_default(value):
    """Last-resort serializer: litellm request dicts can carry datetimes and
    pydantic leftovers; the wire stringifies rather than dropping the event."""
    return str(value)


class Wire:
    """The one-endpoint client. Returns a Verdict dict, or ``None`` when the
    runtime could not answer (timeout, 429, 5xx, network) — deciding what a
    missing verdict means is the CALLER's job: that is the deployment's
    ``fail_mode``, and the degraded-mode spec is explicit that a 429 is an
    outage, not an allow."""

    def __init__(self, runtime_url: str, api_key: str, timeout: float = 5.0):
        self.base = (runtime_url or "").rstrip("/")
        self.api_key = api_key or ""
        self.timeout = timeout

    @property
    def configured(self) -> bool:
        """Whether a runtime is configured at all (URL and key both present)."""
        return bool(self.base and self.api_key)

    def _post(self, path: str, body: dict) -> "tuple[int, dict] | None":
        data = json.dumps(body, default=_json_default).encode("utf-8")
        request = urllib.request.Request(
            self.base + path,
            data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + self.api_key,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as err:  # non-2xx WITH a response
            return err.code, {}
        except Exception as err:  # timeout, refused connection, bad JSON, DNS
            logger.warning("openguardrails: POST %s failed (%s)", path, err)
            return None

    def evaluate(self, event: dict) -> "dict | None":
        """Judge ONE GuardEvent; the whole protocol is this call. A non-2xx
        answer (429 included) is the same as no answer: no verdict."""
        # Stamped HERE, not at each construction site: one send path means the
        # build id cannot go missing on one kind of event only.
        answered = self._post("/v1/evaluate", {**event, "integration": INTEGRATION})
        if answered is None:
            return None
        status, verdict = answered
        if not 200 <= status < 300:
            logger.warning(
                "openguardrails: evaluate answered %d — no verdict", status
            )
            return None
        return verdict

    def heartbeat(self, body: dict) -> bool:
        """Integration liveness (transport-level, not a GuardEvent). Carries
        the build id and the counters that make a fail-open gap visible."""
        answered = self._post("/v1/heartbeat", body)
        return answered is not None and 200 <= answered[0] < 300
