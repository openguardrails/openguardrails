"""SDK client for the OGR Runtime API.

The OGR layering is API → SDK → Plugin: a runtime exposes the HTTP API
(`POST /v1/evaluate`, `POST /v1/ingest`, `POST /v1/enroll`, `POST /v1/heartbeat`,
`GET /v1/approvals`), this module wraps it, and integrations
(plugins) build on the wrapper instead of hand-rolling `urllib` calls.

Stdlib only — the package's zero-dependency promise holds. Ed25519 request
signing (`Ed25519Signer`) is optional and imports `cryptography` lazily.

Wire contract (protocol 0.6):
  /v1/evaluate    one GuardEvent in, one Verdict out (extension keys such as
                  `x.ogr.session_id` pass through). Header `ogr-partial: 1`
                  requests an interim judgment on streaming content.
  /v1/ingest      {"batch": [event, ...]} (max 100), always HTTP 207 with
                  {"results": [{"id", "status", "error"?}, ...]}.
  /v1/enroll      {"public_key": b64url raw 32-byte Ed25519, "pep_id"?,
                  "name"?} → 200/201 {"pep_id", "key_id"}.
  /v1/heartbeat   {"sensor_id"?, "agent_id"?, "interval_s"?, "counters"?} → {"ok"}.
  /v1/approvals   ?guard_id=... → {"status": "pending"|"approved"|"denied"|
                  "expired"}, or 404 {"status": "not_found"}.
Errors: 401 {"error":"unauthorized"}, 429 {"error":"rate_limited","limit"},
400 {"error":"invalid_event","details":[...]}.

Deployed reference runtimes historically mounted the API only under
`/api/public/ogr` — on those, canonical `/v1/*` paths 404 until the operator
upgrades. The client falls back transparently: a route-level 404 on a
canonical path is retried once with `/api/public/ogr` inserted, and the
discovered mount is cached for the client instance. The approvals endpoint's
own semantic 404 (`{"status": "not_found"}`) is a real answer, never a
fallback trigger. There is no fallback in the opposite direction.
"""
from __future__ import annotations

import atexit
import base64
import dataclasses
import json
import logging
import os
import queue
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Iterable

from .models import Category, GuardEvent, OGR_VERSION, Verdict

logger = logging.getLogger("ogr.client")

#: The API caps one /v1/ingest batch at this many events; `ingest` chunks.
INGEST_BATCH_MAX = 100

_SIGNATURE_HEADER = "ogr-batch-signature"

#: Legacy deployment prefix: older reference runtimes mount the API only here.
LEGACY_MOUNT = "/api/public/ogr"


# --------------------------------------------------------------------------- #
# Wire mapping — the one place dataclass ↔ JSON translation lives.
# --------------------------------------------------------------------------- #

def _drop_empties(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None and v != [] and v != ""}


def event_to_wire(ev: GuardEvent | dict[str, Any]) -> dict[str, Any]:
    """GuardEvent dataclass (or already-wire dict) → OGR wire dict.

    Drops empty optionals (None / [] / "") so the result validates against
    guard-event.schema.json, which marks optionals as absent-or-typed, never
    null (v0.6: every identity field is a flat top-level scalar). Dict input
    passes through untouched apart from the empty-drop, so runtime extension
    fields (`run_id`, `turn`, `authz`, ...) survive.
    """
    d = dataclasses.asdict(ev) if dataclasses.is_dataclass(ev) else dict(ev)
    # OGR v0.6: event identity is born at the runtime and returned on the
    # response — a locally minted event_id never goes on the wire, and
    # context_refs left the protocol.
    d.pop("event_id", None)
    d.pop("context_refs", None)
    wire = _drop_empties(d)
    if isinstance(wire.get("provenance"), list):
        wire["provenance"] = [
            _drop_empties(p) if isinstance(p, dict) else p
            for p in wire["provenance"]
        ]
    return wire


_VERDICT_FIELDS = {f.name for f in dataclasses.fields(Verdict)}


def verdict_from_wire(wire: dict[str, Any]) -> Verdict:
    """Wire Verdict dict → Verdict dataclass.

    Keys the dataclass does not model (runtime extensions such as
    `x.ogr.session_id`, `degraded`, or 0.4 `findings`) are preserved on the
    returned object as the `extensions` dict attribute — a plain attribute,
    not a dataclass field, so `to_dict()` stays schema-clean.
    """
    v = Verdict(
        event_id=wire["event_id"],
        guard_id=wire["guard_id"],
        provider=wire["provider"],
        decision=wire["decision"],
        categories=[Category(c["id"], c["domain"], c.get("score", 1.0))
                    for c in wire.get("categories", [])],
        reasons=list(wire.get("reasons", [])),
        latency_ms=wire.get("latency_ms"),
        modifications=wire.get("modifications"),
        ogr_version=wire.get("ogr_version", OGR_VERSION),
    )
    v.extensions = {k: wire[k] for k in wire if k not in _VERDICT_FIELDS}
    return v


# --------------------------------------------------------------------------- #
# Errors
# --------------------------------------------------------------------------- #

class RuntimeAPIError(Exception):
    """A non-2xx response from the Runtime API.

    Attributes: `status` (HTTP status code), `body` (parsed JSON dict, or the
    raw text when the body is not JSON), `error` (the API's error code, e.g.
    "unauthorized" / "invalid_event", when the body carried one).
    """

    def __init__(self, status: int, body: Any, path: str = ""):
        self.status = status
        self.body = body
        self.error = body.get("error") if isinstance(body, dict) else None
        detail = f" ({self.error})" if self.error else ""
        super().__init__(f"OGR runtime {path or 'request'}: HTTP {status}{detail}")


class RateLimitedError(RuntimeAPIError):
    """HTTP 429 — `limit` carries the API's advertised rate limit, if any."""

    def __init__(self, status: int, body: Any, path: str = ""):
        super().__init__(status, body, path)
        self.limit = body.get("limit") if isinstance(body, dict) else None


# --------------------------------------------------------------------------- #
# Optional Ed25519 detached-JWS signing (specification/attestation.md)
# --------------------------------------------------------------------------- #

def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


class Ed25519Signer:
    """Detached-JWS body signer for the `ogr-batch-signature` header.

        header  = {"alg": "EdDSA", "kid": <key_id>, "b64": false, "crit": ["b64"]}
        value   = b64url(header) + ".." + b64url(sig)
        signing input = ascii(b64url(header)) || "." || raw_body

    `private_key` is the raw 32-byte seed (bytes) or its base64url encoding
    (str); omit it to generate a fresh keypair. `key_id` comes back from
    `/v1/enroll` — until it is set, `signature_header` returns None and
    requests go unsigned. Requires the optional `cryptography` package; the
    import is lazy so the core keeps zero hard dependencies.

    Typical bootstrap:
        signer = Ed25519Signer()
        cred = client.enroll(signer.public_key_b64url(), name="my-pep")
        signer.key_id = cred["key_id"]
    """

    def __init__(self, private_key: bytes | str | None = None,
                 key_id: str | None = None):
        try:
            from cryptography.hazmat.primitives import serialization
            from cryptography.hazmat.primitives.asymmetric.ed25519 import (
                Ed25519PrivateKey,
            )
        except ImportError as exc:  # pragma: no cover - env-dependent
            raise ImportError(
                "Ed25519Signer requires the optional 'cryptography' package "
                "(pip install cryptography); the OGR core itself has no "
                "dependencies, so it is not pulled in automatically."
            ) from exc
        self._serialization = serialization
        if private_key is None:
            self._key = Ed25519PrivateKey.generate()
        else:
            if isinstance(private_key, str):
                private_key = base64.urlsafe_b64decode(private_key + "==")
            self._key = Ed25519PrivateKey.from_private_bytes(private_key)
        self.key_id = key_id

    def public_key_b64url(self) -> str:
        """The enrollment payload: base64url of the raw 32-byte public key."""
        s = self._serialization
        return _b64url(self._key.public_key().public_bytes(
            s.Encoding.Raw, s.PublicFormat.Raw))

    def private_key_b64url(self) -> str:
        """base64url of the raw seed — for the caller's own keyfile persistence."""
        s = self._serialization
        return _b64url(self._key.private_bytes(
            s.Encoding.Raw, s.PrivateFormat.Raw, s.NoEncryption()))

    def signature_header(self, body: bytes) -> str | None:
        if not self.key_id:
            return None
        header = _b64url(json.dumps(
            {"alg": "EdDSA", "kid": self.key_id, "b64": False, "crit": ["b64"]},
            separators=(",", ":"),
        ).encode("utf-8"))
        signature = self._key.sign(header.encode("ascii") + b"." + body)
        return f"{header}..{_b64url(signature)}"


# --------------------------------------------------------------------------- #
# The client
# --------------------------------------------------------------------------- #

class RuntimeClient:
    """HTTP client for one OGR runtime.

    `base_url` is the API root; the client appends the canonical `/v1/...`
    paths to it. A runtime mounted behind a prefix therefore passes the full
    prefix as `base_url` — e.g. `https://host/api/public/ogr` yields
    `https://host/api/public/ogr/v1/evaluate`.

    A deployment base URL alone also works against older runtimes that mount
    the API only at `/api/public/ogr`: when a canonical `/v1/...` request
    comes back as a route-level 404, the client retries once with the legacy
    mount inserted and caches the discovered mount for this instance (see
    the module docstring). Approvals' semantic 404 body is never retried.

    `base_url` / `api_key` default to the `OGR_RUNTIME_URL` / `OGR_API_KEY`
    environment variables when omitted. `api_key` is the workspace bearer
    token (`Authorization: Bearer ogr_...`).

    `signer` optionally signs every request body for the
    `ogr-batch-signature` header — either an `Ed25519Signer`, any object with
    a `signature_header(body: bytes) -> str | None` method (e.g. an
    integration's PepIdentity), or a bare callable with that shape. Signing
    that returns None simply leaves the request unsigned.

    Methods raise `RuntimeAPIError` (or `RateLimitedError` on 429) for non-2xx
    responses; transport failures (DNS, refused, timeout) propagate as
    `urllib.error.URLError` / `TimeoutError` for the caller's fail-open /
    fail-closed policy to interpret.
    """

    def __init__(self, base_url: str | None = None, api_key: str | None = None,
                 *, timeout: float = 4.0, signer: Any = None):
        base_url = base_url or os.environ.get("OGR_RUNTIME_URL", "")
        api_key = api_key or os.environ.get("OGR_API_KEY", "")
        if not base_url:
            raise ValueError("RuntimeClient needs base_url (or OGR_RUNTIME_URL)")
        if not api_key:
            raise ValueError("RuntimeClient needs api_key (or OGR_API_KEY)")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.signer = signer
        # Discovered mount prefix, inserted between base_url and the canonical
        # path: "" (canonical) until a route-level 404 reveals a legacy mount.
        self._mount = ""

    # -- endpoints ----------------------------------------------------------
    def evaluate(self, event: GuardEvent | dict[str, Any], *,
                 partial: bool = False) -> Verdict:
        """POST one GuardEvent to /v1/evaluate; return the runtime's Verdict.

        `partial=True` sends `ogr-partial: 1`, asking for an interim judgment
        on still-streaming content. Extension keys in the response land on
        `verdict.extensions`.
        """
        headers = {"ogr-partial": "1"} if partial else None
        wire = self._request("POST", "/v1/evaluate", event_to_wire(event),
                             extra_headers=headers)
        return verdict_from_wire(wire)

    def ingest(self, events: Iterable[GuardEvent | dict[str, Any]],
               ) -> list[dict[str, Any]]:
        """POST GuardEvents to /v1/ingest; return the per-event results.

        The API caps a batch at 100, so longer iterables are sent as multiple
        requests; results come back concatenated in submission order, each
        `{"id", "status", "error"?}` as the runtime's 207 body reported them.
        """
        wires = [event_to_wire(e) for e in events]
        results: list[dict[str, Any]] = []
        for i in range(0, len(wires), INGEST_BATCH_MAX):
            body = self._request("POST", "/v1/ingest",
                                 {"batch": wires[i:i + INGEST_BATCH_MAX]})
            results.extend(body.get("results", []))
        return results

    def guard_request(self, body: dict[str, Any], *,
                      llm_protocol: str | None = None,
                      session_id: str | None = None,
                      agent_id: str | None = None,
                      partial: bool = False) -> Verdict:
        """The developer path in one call: forward the UNTOUCHED provider
        request body BEFORE it goes to the model. The runtime classifies it
        (new user words, fed-back tool outcomes, tool definitions) and
        answers with the composed Verdict.

            verdict = client.guard_request(chat_completions_body)
            if verdict.decision == "block":
                refuse(verdict.reasons)
        """
        return self.evaluate(GuardEvent(
            kind="llm_request", payload=body, llm_protocol=llm_protocol,
            session_id=session_id, agent_id=agent_id,
        ), partial=partial)

    def guard_response(self, body: dict[str, Any], *,
                       llm_protocol: str | None = None,
                       session_id: str | None = None,
                       agent_id: str | None = None,
                       partial: bool = False) -> Verdict:
        """The other half: forward the UNTOUCHED provider response AFTER
        the model answers and BEFORE the agent acts on it."""
        return self.evaluate(GuardEvent(
            kind="llm_response", payload=body, llm_protocol=llm_protocol,
            session_id=session_id, agent_id=agent_id,
        ), partial=partial)

    def enroll(self, public_key: str | bytes, pep_id: str | None = None,
               name: str | None = None) -> dict[str, Any]:
        """POST /v1/enroll; returns `{"pep_id", "key_id"}`.

        `public_key` is the raw 32-byte Ed25519 public key (bytes) or its
        base64url encoding (str, e.g. `Ed25519Signer.public_key_b64url()`).
        """
        if isinstance(public_key, (bytes, bytearray)):
            public_key = _b64url(bytes(public_key))
        payload: dict[str, Any] = {"public_key": public_key}
        if pep_id:
            payload["pep_id"] = pep_id
        if name:
            payload["name"] = name
        return self._request("POST", "/v1/enroll", payload)

    def heartbeat(self, sensor_id: str | None = None,
                  agent_id: str | None = None,
                  sensor_type: str | None = None,
                  sensor_version: str | None = None,
                  interval_s: float | None = None,
                  counters: dict[str, Any] | None = None) -> dict[str, Any]:
        """POST /v1/heartbeat (liveness); returns `{"ok": true}`.

        v0.6: flat fields, like every other identity field — at least one of
        `sensor_id` / `agent_id`."""
        payload: dict[str, Any] = {}
        if sensor_id:
            payload["sensor_id"] = sensor_id
        if sensor_type:
            payload["sensor_type"] = sensor_type
        if sensor_version:
            payload["sensor_version"] = sensor_version
        if agent_id:
            payload["agent_id"] = agent_id
        if interval_s is not None:
            payload["interval_s"] = interval_s
        if counters:
            payload["counters"] = counters
        return self._request("POST", "/v1/heartbeat", payload)

    def get_approval(self, guard_id: str) -> dict[str, Any]:
        """GET /v1/approvals?guard_id=... — poll a require_approval decision.

        Returns `{"status": "pending"|"approved"|"denied"|"expired"}`; an
        unknown guard_id returns `{"status": "not_found"}` (the API's 404
        body) rather than raising, so pollers branch on `status` alone.
        """
        query = urllib.parse.urlencode({"guard_id": guard_id})
        try:
            return self._request("GET", f"/v1/approvals?{query}")
        except RuntimeAPIError as exc:
            if exc.status == 404 and isinstance(exc.body, dict) and "status" in exc.body:
                return exc.body
            raise

    # -- transport ----------------------------------------------------------
    def _signature(self, body: bytes) -> str | None:
        if self.signer is None:
            return None
        sign = getattr(self.signer, "signature_header", self.signer)
        return sign(body)

    def _request(self, method: str, path: str,
                 payload: dict[str, Any] | None = None,
                 extra_headers: dict[str, str] | None = None) -> dict[str, Any]:
        headers = {"authorization": f"Bearer {self.api_key}"}
        if extra_headers:
            headers.update(extra_headers)
        data = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["content-type"] = "application/json"
            signature = self._signature(data)
            if signature:
                headers[_SIGNATURE_HEADER] = signature
        try:
            return self._send(method, self._mount + path, data, headers)
        except RuntimeAPIError as exc:
            if not self._legacy_mount_worth_trying(exc):
                raise
            body = self._send(method, LEGACY_MOUNT + path, data, headers)
            self._mount = LEGACY_MOUNT  # cache: later requests skip the probe
            return body

    def _legacy_mount_worth_trying(self, exc: RuntimeAPIError) -> bool:
        """True when a 404 on a canonical path may mean "older runtime mounted
        only at /api/public/ogr" rather than an API answer.

        The API itself uses 404 only for approvals lookups, and that body is
        `{"status": "not_found"}` — a 404 carrying a `status` key is therefore
        a real answer and never retried. A route-level 404 (HTML, plain text,
        or `{"error": ...}`) on the canonical mount triggers exactly one retry
        against the legacy mount; never the other way round, and never when
        `base_url` already ends in the legacy prefix.
        """
        return (exc.status == 404
                and not self._mount
                and not self.base_url.endswith(LEGACY_MOUNT)
                and not (isinstance(exc.body, dict) and "status" in exc.body))

    def _send(self, method: str, path: str, data: bytes | None,
              headers: dict[str, str]) -> dict[str, Any]:
        req = urllib.request.Request(self.base_url + path, data=data,
                                     method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as exc:
            raise self._api_error(exc, path) from None
        return json.loads(raw.decode("utf-8")) if raw else {}

    @staticmethod
    def _api_error(exc: urllib.error.HTTPError, path: str) -> RuntimeAPIError:
        raw = b""
        try:
            raw = exc.read()
        except Exception:  # noqa: BLE001 - body is best-effort
            pass
        try:
            body: Any = json.loads(raw.decode("utf-8"))
        except Exception:  # noqa: BLE001
            body = raw.decode("utf-8", "replace")
        cls = RateLimitedError if exc.code == 429 else RuntimeAPIError
        return cls(exc.code, body, path)


# --------------------------------------------------------------------------- #
# Optional background batcher for /v1/ingest (observability path)
# --------------------------------------------------------------------------- #

class BatchingIngestor:
    """Fire-and-forget batcher: `submit()` GuardEvents, a daemon thread posts
    them via `client.ingest`, and an atexit hook drains what a short-lived
    process would otherwise lose. Never raises, never blocks the caller;
    a full queue drops the OLDEST event (observability must not leak memory),
    and a dead runtime costs bounded time on exit, not a hang.
    """

    def __init__(self, client: RuntimeClient, *, batch_max: int = 50,
                 flush_seconds: float = 2.0, queue_max: int = 1000,
                 flush_deadline: float = 6.0):
        self.client = client
        self.batch_max = min(batch_max, INGEST_BATCH_MAX)
        self.flush_seconds = flush_seconds
        self.flush_deadline = flush_deadline
        self._queue: "queue.Queue[dict[str, Any]]" = queue.Queue(maxsize=queue_max)
        self._worker = threading.Thread(
            target=self._run, name="ogr-batching-ingestor", daemon=True)
        self._worker.start()
        atexit.register(self.flush)

    def submit(self, event: GuardEvent | dict[str, Any]) -> None:
        """Queue one event. Never raises, never blocks."""
        wire = event_to_wire(event)
        try:
            self._queue.put_nowait(wire)
        except queue.Full:
            try:  # drop-oldest keeps the newest signal
                self._queue.get_nowait()
                self._queue.put_nowait(wire)
            except queue.Empty:
                pass

    def flush(self, deadline_seconds: float | None = None) -> int:
        """Post whatever is queued, synchronously; returns events sent.

        Runs at interpreter exit and is callable directly by tests and
        one-shot scripts. Bounded by the deadline because it sits on the
        process's way out. Safe alongside the worker: `queue.Queue` hands
        each event to exactly one consumer, so the two can split a batch but
        never duplicate one. Not a guarantee — `os._exit`, a signal, or a
        hard kill skips atexit, and the queue is memory by design.
        """
        sent = 0
        deadline = time.monotonic() + (deadline_seconds if deadline_seconds
                                       is not None else self.flush_deadline)
        while time.monotonic() < deadline:
            batch = self._drain(self.batch_max)
            if not batch:
                break
            sent += self._post(batch)
        return sent

    def _drain(self, n: int) -> list[dict[str, Any]]:
        batch: list[dict[str, Any]] = []
        try:
            while len(batch) < n:
                batch.append(self._queue.get_nowait())
        except queue.Empty:
            pass
        return batch

    def _post(self, batch: list[dict[str, Any]]) -> int:
        try:
            results = self.client.ingest(batch)
        except Exception as exc:  # noqa: BLE001 - observability never raises
            logger.warning("OGR ingest failed (%s) — %d events dropped",
                           exc, len(batch))
            return 0
        rejected = [r for r in results if r.get("status", 200) >= 300]
        if rejected:
            logger.warning("OGR ingest rejected %d/%d events: %s",
                           len(rejected), len(batch), rejected)
        return len(batch)

    def _run(self) -> None:
        batch: list[dict[str, Any]] = []
        while True:
            try:
                batch.append(self._queue.get(timeout=self.flush_seconds))
            except queue.Empty:
                continue
            batch.extend(self._drain(self.batch_max - len(batch)))
            self._post(batch)
            batch = []
