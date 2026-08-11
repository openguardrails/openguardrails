"""PEP enrollment identity: an Ed25519 keypair + detached-JWS request signing.

Spec: specification/attestation.md + enrollment-and-receipts.md. The gateway
enrolls once (workspace API key = bootstrap token, POST /v1/enroll) and signs
every runtime request body with `OGR-Batch-Signature`:

    b64url(header)..b64url(sig)   header = {alg:"EdDSA", kid, b64:false, crit:["b64"]}
    signing input = ascii(b64url(header)) || "." || raw_body

A verified signature raises the channel's attestation ceiling to the
credential's enrollment scope; without it the runtime clamps subject claims
to the unenrolled floor. Everything here is best-effort: any failure leaves
the gateway running unsigned (observability-first, never blocks traffic).

The keypair, JWS construction, and enroll transport are the core SDK's
(`openguardrails.client.Ed25519Signer` / `RuntimeClient`); this module keeps
the gateway-owned parts — keyfile persistence ({"private_key": b64url seed,
"guard_id", "key_id"} at ~/.ogr/gateway-ed25519.json), enroll-once semantics,
and graceful unsigned degradation.
"""
from __future__ import annotations

import json
import logging
import os
import pathlib

from openguardrails import Ed25519Signer, RuntimeClient

logger = logging.getLogger("ogr")


class PepIdentity:
    """Load-or-create the gateway's keypair; enroll; sign request bodies."""

    def __init__(self, keyfile: str | None = None):
        self.keyfile = pathlib.Path(
            keyfile
            or os.environ.get("OGR_KEYFILE", "")
            or pathlib.Path.home() / ".ogr" / "gateway-ed25519.json"
        )
        self.guard_id: str | None = None
        self.key_id: str | None = None
        self._signer: Ed25519Signer | None = None
        self._load_or_create()

    # -- keypair ------------------------------------------------------------
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
        except Exception as exc:  # noqa: BLE001 - never block the proxy
            logger.warning("OGR PEP identity unavailable (%s) — running unsigned", exc)
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

    # -- enrollment ----------------------------------------------------------
    def enroll(self, base_url: str, api_key: str, timeout: float = 5.0) -> bool:
        """POST /v1/enroll (idempotent per public key). True when signing is live."""
        if not self._signer:
            return False
        if self.guard_id and self.key_id:
            return True
        try:
            cred = RuntimeClient(base_url, api_key, timeout=timeout).enroll(
                self.public_key_b64url(), name="mitmproxy-gateway")
            self.guard_id = cred["guard_id"]
            self.key_id = cred["key_id"]
            self._persist()
            logger.info("OGR PEP enrolled: guard_id=%s key_id=%s", self.guard_id, self.key_id)
            return True
        except Exception as exc:  # noqa: BLE001
            logger.warning("OGR enrollment failed (%s) — running unsigned", exc)
        return False

    # -- signing ---------------------------------------------------------------
    def signature_header(self, body: bytes) -> str | None:
        """`OGR-Batch-Signature` value for this body, or None when unsigned."""
        if not self._signer or not self.key_id:
            return None
        self._signer.key_id = self.key_id
        return self._signer.signature_header(body)
