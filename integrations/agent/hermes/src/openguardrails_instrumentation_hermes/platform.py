"""Optional platform reporter: ship this plugin's GuardEvents to an
OpenGuardrails runtime with an enrolled per-INSTANCE identity.

Local enforcement (bridge.py + the in-process reference runtime) is untouched
and stays authoritative; this module only adds observability with a verifiable
identity. Hermes is the "many instances per machine" case of the identity
design (runtime docs/agent-identity-and-service-auth.md §7): each instance
enrolls its own Ed25519 key (`OGR_INSTANCE` names it, keyfile per instance)
and asserts `subject.agent_id = hermes-<instance>` with a `client_key`
attestation claim — the runtime clamps that to the key's enrollment scope.

Transport is the core SDK (`openguardrails.client`): `RuntimeClient` speaks
the canonical `/v1/*` paths against OGR_RUNTIME_URL and falls back to the
legacy `/api/public/ogr` mount automatically; `BatchingIngestor` is the
fire-and-forget batch thread; `Ed25519Signer` holds the keypair. This module
keeps only what is Hermes-specific: instance naming, keyfile persistence,
enroll-once semantics, and the never-block/never-raise reporting contract.

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
  OGR_AGENT_OWNER   agent_owner override — the builder/responsible party,
                    default "user:<login>" (a personal agent's owner is the
                    person running it)
  OGR_AGENT_USER    agent_user override — who this instance serves, default
                    "user:<login>" (a personal agent serves its owner)
  OGR_AGENT_WORKSPACE  the group of agents this instance belongs to; unset
                    lands in the API key's workspace
  OGR_KEYFILE       keypair path, default ~/.ogr/hermes-<instance>-ed25519.json
"""
from __future__ import annotations

import getpass
import json
import logging
import os
import pathlib
import socket
import threading
import time
from typing import Any

from openguardrails import BatchingIngestor, Ed25519Signer, RuntimeClient
from openguardrails.client import event_to_wire  # noqa: F401 - re-exported (bridge, tests)

logger = logging.getLogger("ogr.platform")

_BATCH_MAX = 50          # ingest accepts up to 100; stay well under
_FLUSH_SECONDS = 2.0
_QUEUE_MAX = 1000        # drop-oldest beyond this; observability must not leak memory
# How long the exit drain may take in total. One ingest POST is capped at 5s, so this
# allows a couple of batches without letting a dead runtime hold a CLI open.
_FLUSH_DEADLINE = 6.0
_REQUEST_TIMEOUT = 5.0   # enroll + ingest POSTs


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


def _local_user() -> str:
    try:
        return f"user:{getpass.getuser()}"
    except Exception:  # noqa: BLE001
        return "user:unknown"


def agent_owner() -> str:
    """The agent's builder/responsible party. A personal agent's owner is the
    person running it, so the local login is the default."""
    return os.environ.get("OGR_AGENT_OWNER", "").strip() or _local_user()


def agent_user() -> str:
    """Who this instance serves. Hermes is a personal agent: every session has
    the same user, and that user is its owner unless told otherwise."""
    return os.environ.get("OGR_AGENT_USER", "").strip() or _local_user()


def subject_for(**extra: Any) -> dict[str, Any]:
    """The per-instance identity kwargs every event of this plugin asserts —
    the flat v0.6 agent five-tuple, splatted into GuardEvent(**...).

    `attestation: client_key` is the honest claim for an in-process hook that
    holds its own enrolled credential; the runtime clamps it to whatever this
    key's enrollment scope allows.
    """
    subject: dict[str, Any] = {
        "agent_id": agent_id(),
        "agent_type": "hermes",
        "agent_owner": agent_owner(),
        "agent_user": agent_user(),
        "attestation": "client_key",
    }
    workspace = os.environ.get("OGR_AGENT_WORKSPACE", "").strip()
    if workspace:
        subject["agent_workspace"] = workspace
    subject.update(extra)
    return subject


class PepIdentity:
    """Per-instance Ed25519 enrollment identity (mitmproxy PepIdentity pattern).

    Wraps the SDK's `Ed25519Signer`, keeping the Hermes-owned parts: the
    keyfile location and format ({"private_key": b64url seed, "guard_id",
    "key_id"}), enroll-once semantics, and graceful unsigned degradation when
    `cryptography` is missing or the keyfile is unusable.
    """

    def __init__(self, keyfile: str | None = None):
        self.keyfile = pathlib.Path(
            keyfile
            or os.environ.get("OGR_KEYFILE", "")
            or pathlib.Path.home() / ".ogr" / f"hermes-{instance_name()}-ed25519.json"
        )
        self.guard_id: str | None = None
        self.key_id: str | None = None
        self._signer: Ed25519Signer | None = None
        self._load_or_create()

    def _load_or_create(self) -> None:
        try:
            if self.keyfile.exists():
                stored = json.loads(self.keyfile.read_text())
                self._signer = Ed25519Signer(stored["private_key"])
                self.guard_id = stored.get("guard_id")
                self.key_id = stored.get("key_id")
            else:
                self._signer = Ed25519Signer()
                self._persist()
        except Exception as exc:  # noqa: BLE001 - includes missing `cryptography`
            logger.warning("OGR PEP identity unavailable (%s) — reporting unsigned", exc)
            self._signer = None

    def _persist(self) -> None:
        self.keyfile.parent.mkdir(parents=True, exist_ok=True)
        self.keyfile.write_text(json.dumps({
            "private_key": self._signer.private_key_b64url(),  # type: ignore[union-attr]
            "guard_id": self.guard_id,
            "key_id": self.key_id,
        }))
        self.keyfile.chmod(0o600)

    def public_key_b64url(self) -> str | None:
        return self._signer.public_key_b64url() if self._signer else None

    def enroll(self, base_url: str, api_key: str, timeout: float = 5.0) -> bool:
        if not self._signer:
            return False
        if self.guard_id and self.key_id:
            return True
        try:
            cred = RuntimeClient(base_url, api_key, timeout=timeout).enroll(
                self.public_key_b64url(),
                guard_id=f"hermes-hook-{instance_name()}",
                name=f"hermes hook ({instance_name()})",
            )
            self.guard_id = cred["guard_id"]
            self.key_id = cred["key_id"]
            self._persist()
            logger.info("OGR enrolled: %s (%s)", self.guard_id, self.key_id)
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("OGR enrollment failed (%s) — reporting unsigned", exc)
            return False

    def signature_header(self, body: bytes) -> str | None:
        if not self._signer or not self.key_id:
            return None
        self._signer.key_id = self.key_id
        return self._signer.signature_header(body)


class PlatformReporter(BatchingIngestor):
    """Fire-and-forget batcher: GuardEvents → signed POST /ingest.

    The queue, worker thread, exit drain, and ingest transport are the SDK's
    `BatchingIngestor` + `RuntimeClient`; this subclass adds the enabled-only-
    when-configured gate and the lazy enroll-once identity that signs bodies.
    """

    def __init__(self) -> None:
        self.base_url = os.environ.get("OGR_RUNTIME_URL", "").rstrip("/")
        self.api_key = os.environ.get("OGR_API_KEY", "")
        self.enabled = bool(self.base_url and self.api_key)
        self._identity: PepIdentity | None = None
        self._identity_lock = threading.Lock()
        if not self.enabled:
            self.client = None
            return
        # Drain on the way out (BatchingIngestor registers atexit). The worker
        # is a DAEMON thread parked on a 2s timer, so a short-lived process —
        # `hermes -z`, a one-shot script, a kanban worker subprocess — exits
        # with the queue still full and every event in it silently gone. That
        # is how `user_input` went missing from the console for one-shot runs
        # while `model_output` survived: the latter also rides the synchronous
        # /evaluate call, which enqueues it runtime-side. Nothing warns,
        # because nothing failed.
        super().__init__(
            RuntimeClient(self.base_url, self.api_key,
                          timeout=_REQUEST_TIMEOUT, signer=self._body_signature),
            batch_max=_BATCH_MAX, flush_seconds=_FLUSH_SECONDS,
            queue_max=_QUEUE_MAX, flush_deadline=_FLUSH_DEADLINE,
        )
        # Synchronous /evaluate shares the identity but keeps its own client:
        # its timeout is the caller's enforcement-point budget, not the
        # reporter's batch budget.
        self._eval_client = RuntimeClient(
            self.base_url, self.api_key, signer=self._body_signature)

    def _body_signature(self, body: bytes) -> str | None:
        """RuntimeClient signer hook — signs once the identity is enrolled."""
        return self._identity.signature_header(body) if self._identity else None

    def report(self, ev: Any) -> None:
        """Queue one GuardEvent (dataclass or dict). Never raises, never blocks."""
        if not self.enabled:
            return
        self.submit(ev)

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
            batch = self._drain(_BATCH_MAX)
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
            self._identity.enroll(self.base_url, self.api_key,
                                  timeout=_REQUEST_TIMEOUT)

    def _run(self) -> None:
        self._ensure_identity()
        BatchingIngestor._run(self)


_reporter: PlatformReporter | None = None


def get_reporter() -> PlatformReporter:
    global _reporter
    if _reporter is None:
        _reporter = PlatformReporter()
    return _reporter


def _verdict_wire(v: Any) -> dict[str, Any]:
    """SDK Verdict dataclass → the parsed wire dict callers historically got
    (empty optionals absent, runtime extension keys such as `degraded` kept)."""
    wire = {k: val for k, val in v.to_dict().items()
            if val is not None and val != []}
    wire.update(getattr(v, "extensions", {}))
    return wire


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
    client = reporter._eval_client
    client.timeout = timeout
    try:
        return _verdict_wire(client.evaluate(wire))
    except Exception as exc:  # noqa: BLE001
        logger.warning("OGR evaluate failed (%s) — caller decides fallback", exc)
        return None
