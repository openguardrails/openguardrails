"""Optional platform reporter: ship this plugin's GuardEvents to an
OpenGuardrails runtime with an enrolled per-INSTANCE identity.

Local enforcement (bridge.py + the in-process reference runtime) is untouched
and stays authoritative; this module only adds observability with a verifiable
identity. Hermes is the "many instances per machine" case of the identity
design (runtime docs/agent-identity-and-service-auth.md §7): each instance
enrolls its own Ed25519 key (`OGR_INSTANCE` names it, keyfile per instance)
and asserts `subject.agent_id = hermes-<instance>` with a `client_key`
attestation claim — the runtime clamps that to the key's enrollment scope.

Enabled only when OGR_RUNTIME_URL + OGR_API_KEY are set; everything is
best-effort and never blocks or fails a hook.

Env:
  OGR_RUNTIME_URL   runtime base URL (unset = reporter disabled)
  OGR_API_KEY       workspace API key (bootstrap token for enrollment)
  OGR_INSTANCE      instance name, default: hostname, plus the HERMES_HOME
                     basename when that's set to a non-default path (Hermes'
                     own mechanism for running genuinely separate instances
                     on one machine, each with its own config/session
                     history — two processes sharing the default home are
                     the same logical install and collapse to one instance;
                     session_id already tells their conversations apart).
                     Set explicitly to override either signal.
  OGR_PRINCIPAL     principal override, default "user:<login>"
  OGR_KEYFILE       keypair path, default ~/.ogr/hermes-<instance>-ed25519.json
"""
from __future__ import annotations

import atexit
import base64
import dataclasses
import getpass
import json
import logging
import os
import pathlib
import queue
import socket
import threading
import time
import urllib.error
import urllib.request
from typing import Any

logger = logging.getLogger("ogr.platform")

try:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    _HAVE_CRYPTO = True
except ImportError:  # pragma: no cover - reporter then runs unsigned
    _HAVE_CRYPTO = False

_BATCH_MAX = 50          # ingest accepts up to 100; stay well under
_FLUSH_SECONDS = 2.0
_QUEUE_MAX = 1000        # drop-oldest beyond this; observability must not leak memory
# How long the exit drain may take in total. One ingest POST is capped at 5s, so this
# allows a couple of batches without letting a dead runtime hold a CLI open.
_FLUSH_DEADLINE = 6.0


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def instance_name() -> str:
    explicit = os.environ.get("OGR_INSTANCE", "").strip()
    if explicit:
        return explicit
    host = ""
    try:
        host = socket.gethostname().strip()
    except Exception:  # noqa: BLE001
        pass
    host = host or "default"
    # HERMES_HOME is Hermes' OWN mechanism for running multiple genuinely
    # separate instances on one machine (each gets its own config/session
    # history) — fold its basename in so those disambiguate automatically.
    # Two processes sharing the SAME (default) home collapse to one
    # instance, which is correct: they're the same logical install, and
    # session_id already tells their conversations apart in the console.
    home = os.environ.get("HERMES_HOME", "").strip()
    if home:
        tag = pathlib.Path(home).expanduser().name.strip(".") or "home"
        return f"{host}-{tag}"
    return host


def agent_id() -> str:
    return f"hermes-{instance_name()}"


def principal() -> str:
    explicit = os.environ.get("OGR_PRINCIPAL", "").strip()
    if explicit:
        return explicit
    try:
        return f"user:{getpass.getuser()}"
    except Exception:  # noqa: BLE001
        return "user:unknown"


def subject_for(**extra: Any) -> dict[str, Any]:
    """The explicit per-instance subject every event of this plugin asserts.

    `attestation: client_key` is the honest claim for an in-process hook that
    holds its own enrolled credential; the runtime clamps it to whatever this
    key's enrollment scope allows.
    """
    subject: dict[str, Any] = {
        "agent_id": agent_id(),
        "agent_type": "hermes",
        "principal": principal(),
        "attestation": "client_key",
    }
    subject.update(extra)
    return subject


class PepIdentity:
    """Per-instance Ed25519 enrollment identity (mitmproxy PepIdentity pattern)."""

    def __init__(self, keyfile: str | None = None):
        self.keyfile = pathlib.Path(
            keyfile
            or os.environ.get("OGR_KEYFILE", "")
            or pathlib.Path.home() / ".ogr" / f"hermes-{instance_name()}-ed25519.json"
        )
        self.guard_id: str | None = None
        self.key_id: str | None = None
        self._key: "Ed25519PrivateKey | None" = None
        if _HAVE_CRYPTO:
            self._load_or_create()

    def _load_or_create(self) -> None:
        try:
            if self.keyfile.exists():
                stored = json.loads(self.keyfile.read_text())
                raw = base64.urlsafe_b64decode(stored["private_key"] + "==")
                self._key = Ed25519PrivateKey.from_private_bytes(raw)
                self.guard_id = stored.get("guard_id")
                self.key_id = stored.get("key_id")
            else:
                self._key = Ed25519PrivateKey.generate()
                self._persist()
        except Exception as exc:  # noqa: BLE001
            logger.warning("OGR PEP identity unavailable (%s) — reporting unsigned", exc)
            self._key = None

    def _persist(self) -> None:
        raw = self._key.private_bytes(  # type: ignore[union-attr]
            serialization.Encoding.Raw,
            serialization.PrivateFormat.Raw,
            serialization.NoEncryption(),
        )
        self.keyfile.parent.mkdir(parents=True, exist_ok=True)
        self.keyfile.write_text(json.dumps({
            "private_key": _b64url(raw),
            "guard_id": self.guard_id,
            "key_id": self.key_id,
        }))
        self.keyfile.chmod(0o600)

    def public_key_b64url(self) -> str | None:
        if not self._key:
            return None
        return _b64url(self._key.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw,
        ))

    def enroll(self, base_url: str, api_key: str, timeout: float = 5.0) -> bool:
        if not self._key:
            return False
        if self.guard_id and self.key_id:
            return True
        req = urllib.request.Request(
            base_url.rstrip("/") + "/api/public/ogr/v1/enroll",
            data=json.dumps({
                "public_key": self.public_key_b64url(),
                "guard_id": f"hermes-hook-{instance_name()}",
                "name": f"hermes hook ({instance_name()})",
            }).encode("utf-8"),
            method="POST",
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {api_key}",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                cred = json.loads(resp.read().decode("utf-8"))
            self.guard_id = cred["guard_id"]
            self.key_id = cred["key_id"]
            self._persist()
            logger.info("OGR enrolled: %s (%s)", self.guard_id, self.key_id)
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("OGR enrollment failed (%s) — reporting unsigned", exc)
            return False

    def signature_header(self, body: bytes) -> str | None:
        if not self._key or not self.key_id:
            return None
        header = _b64url(json.dumps(
            {"alg": "EdDSA", "kid": self.key_id, "b64": False, "crit": ["b64"]},
            separators=(",", ":"),
        ).encode("utf-8"))
        signature = self._key.sign(header.encode("ascii") + b"." + body)
        return f"{header}..{_b64url(signature)}"


def event_to_wire(ev: Any) -> dict[str, Any]:
    """Python-core GuardEvent dataclass → OGR wire dict (drop empties)."""
    d = dataclasses.asdict(ev)
    wire = {k: v for k, v in d.items() if v not in (None, [], "")}
    if not wire.get("provenance"):
        wire.pop("provenance", None)
    return wire


class PlatformReporter:
    """Fire-and-forget batcher: GuardEvents → signed POST /ingest."""

    def __init__(self) -> None:
        self.base_url = os.environ.get("OGR_RUNTIME_URL", "").rstrip("/")
        self.api_key = os.environ.get("OGR_API_KEY", "")
        self.enabled = bool(self.base_url and self.api_key)
        self._queue: "queue.Queue[dict[str, Any]]" = queue.Queue(maxsize=_QUEUE_MAX)
        self._identity: PepIdentity | None = None
        self._identity_lock = threading.Lock()
        self._worker: threading.Thread | None = None
        if self.enabled:
            self._worker = threading.Thread(
                target=self._run, name="ogr-platform-reporter", daemon=True,
            )
            self._worker.start()
            # Drain on the way out. The worker is a DAEMON thread parked on a 2s
            # timer, so a short-lived process — `hermes -z`, a one-shot script, a
            # kanban worker subprocess — exits with the queue still full and every
            # event in it silently gone. That is how `user_input` went missing from
            # the console for one-shot runs while `model_output` survived: the
            # latter also rides the synchronous /evaluate call, which enqueues it
            # runtime-side. Nothing warns, because nothing failed.
            atexit.register(self.flush)

    def report(self, ev: Any) -> None:
        """Queue one GuardEvent (dataclass or dict). Never raises, never blocks."""
        if not self.enabled:
            return
        wire = event_to_wire(ev) if dataclasses.is_dataclass(ev) else dict(ev)
        try:
            self._queue.put_nowait(wire)
        except queue.Full:
            try:  # drop-oldest keeps the newest signal
                self._queue.get_nowait()
                self._queue.put_nowait(wire)
            except queue.Empty:
                pass

    def flush(self, deadline_seconds: float = _FLUSH_DEADLINE) -> int:
        """Post whatever is queued, synchronously. Returns the number of events sent.

        Runs at interpreter exit, and callable directly by tests and short scripts
        that would otherwise have to sleep and hope. Bounded by `deadline_seconds`
        because this is on the process's way out: observability must not hold a CLI
        open, so a slow or unreachable runtime costs one timeout, not a hang.

        Safe to run alongside the worker — `queue.Queue` hands each event to exactly
        one of them, so the two can only split a batch, never duplicate one. It does
        its own enrollment for the case the worker never got that far, which is the
        common one for a process that lived half a second.

        Not a guarantee: `os._exit`, a signal, or a hard kill skips `atexit`
        entirely. Events genuinely in flight then are still lost — the queue is
        memory, by design (`_QUEUE_MAX` drops oldest rather than growing).
        """
        if not self.enabled:
            return 0
        sent = 0
        deadline = time.monotonic() + deadline_seconds
        while time.monotonic() < deadline:
            batch: list[dict[str, Any]] = []
            try:
                while len(batch) < _BATCH_MAX:
                    batch.append(self._queue.get_nowait())
            except queue.Empty:
                pass
            if not batch:
                break
            self._ensure_identity()
            self._post(batch)
            sent += len(batch)
        return sent

    def _ensure_identity(self) -> None:
        """Enroll once, from whichever thread gets there first."""
        with self._identity_lock:
            if self._identity is None:
                self._identity = PepIdentity()
            # enroll() is a no-op once guard_id/key_id are known (persisted keyfile),
            # so this costs one network call per fresh install, not per batch.
            self._identity.enroll(self.base_url, self.api_key)

    # -- background loop ------------------------------------------------------
    def _run(self) -> None:
        self._ensure_identity()
        batch: list[dict[str, Any]] = []
        while True:
            try:
                batch.append(self._queue.get(timeout=_FLUSH_SECONDS))
                while len(batch) < _BATCH_MAX:
                    batch.append(self._queue.get_nowait())
            except queue.Empty:
                pass
            if batch:
                self._post(batch)
                batch = []

    def _post(self, batch: list[dict[str, Any]]) -> None:
        body = json.dumps({"batch": batch}).encode("utf-8")
        headers = {
            "content-type": "application/json",
            "authorization": f"Bearer {self.api_key}",
        }
        signature = self._identity.signature_header(body) if self._identity else None
        if signature:
            headers["ogr-batch-signature"] = signature
        req = urllib.request.Request(
            self.base_url + "/api/public/ogr/v1/ingest",
            data=body, method="POST", headers=headers,
        )
        try:
            raw = urllib.request.urlopen(req, timeout=5.0).read()
        except Exception as exc:  # noqa: BLE001
            logger.warning("OGR ingest failed (%s) — %d events dropped", exc, len(batch))
            return
        try:
            rejected = [
                r for r in json.loads(raw.decode("utf-8")).get("results", [])
                if r.get("status", 200) >= 300
            ]
        except Exception:  # noqa: BLE001
            return
        if rejected:
            logger.warning("OGR ingest rejected %d/%d events: %s",
                            len(rejected), len(batch), rejected)


_reporter: PlatformReporter | None = None


def get_reporter() -> PlatformReporter:
    global _reporter
    if _reporter is None:
        _reporter = PlatformReporter()
    return _reporter


def evaluate(wire: dict[str, Any], timeout: float = 4.0) -> dict[str, Any] | None:
    """Synchronous signed POST /evaluate — the real PDP's verdict for a single
    GuardEvent, when a runtime is configured (OGR_RUNTIME_URL + OGR_API_KEY).

    This is the ONE place this integration blocks on the network: callers use
    it at a real enforcement point (a tool is about to run), so `timeout` is
    deliberately short — a stalled/cold gateway must not freeze the agent.
    Returns the parsed verdict dict, or None on ANY failure (not configured,
    timeout, non-2xx, bad JSON) — the caller decides what None means for its
    altitude (this module has no opinion on fail-open vs fail-closed)."""
    reporter = get_reporter()
    if not reporter.enabled:
        return None
    body = json.dumps(wire).encode("utf-8")
    headers = {
        "content-type": "application/json",
        "authorization": f"Bearer {reporter.api_key}",
    }
    signature = reporter._identity.signature_header(body) if reporter._identity else None
    if signature:
        headers["ogr-batch-signature"] = signature
    req = urllib.request.Request(
        reporter.base_url + "/api/public/ogr/v1/evaluate",
        data=body, method="POST", headers=headers,
    )
    try:
        raw = urllib.request.urlopen(req, timeout=timeout).read()
        return json.loads(raw.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        logger.warning("OGR evaluate failed (%s) — caller decides fallback", exc)
        return None
