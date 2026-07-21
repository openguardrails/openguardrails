"""PEP enrollment identity: an Ed25519 keypair + detached-JWS request signing.

Spec: specification/attestation.md + enrollment-and-receipts.md. The gateway
enrolls once (workspace API key = bootstrap token, POST /enroll) and signs
every runtime request body with `OGR-Batch-Signature`:

    b64url(header)..b64url(sig)   header = {alg:"EdDSA", kid, b64:false, crit:["b64"]}
    signing input = ascii(b64url(header)) || "." || raw_body

A verified signature raises the channel's attestation ceiling to the
credential's enrollment scope; without it the runtime clamps subject claims
to the unenrolled floor. Everything here is best-effort: any failure leaves
the gateway running unsigned (observability-first, never blocks traffic).
"""
from __future__ import annotations

import base64
import json
import logging
import os
import pathlib
import urllib.error
import urllib.request

logger = logging.getLogger("ogr")

try:  # mitmproxy always ships `cryptography`; degrade gracefully without it.
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    _HAVE_CRYPTO = True
except ImportError:  # pragma: no cover
    _HAVE_CRYPTO = False


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


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
        self._key: "Ed25519PrivateKey | None" = None
        if _HAVE_CRYPTO:
            self._load_or_create()

    # -- keypair ------------------------------------------------------------
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
        except Exception as exc:  # noqa: BLE001 - never block the proxy
            logger.warning("OGR PEP identity unavailable (%s) — running unsigned", exc)
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

    # -- enrollment ----------------------------------------------------------
    def enroll(self, base_url: str, api_key: str, timeout: float = 5.0) -> bool:
        """POST /enroll (idempotent per public key). True when signing is live."""
        if not self._key:
            return False
        if self.guard_id and self.key_id:
            return True
        public_key = self.public_key_b64url()
        req = urllib.request.Request(
            base_url.rstrip("/") + "/api/public/ogr/v1/enroll",
            data=json.dumps({
                "public_key": public_key,
                "name": "mitmproxy-gateway",
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
            logger.info("OGR PEP enrolled: guard_id=%s key_id=%s", self.guard_id, self.key_id)
            return True
        except urllib.error.HTTPError as exc:
            # 404 = runtime predates enrollment; anything else is logged too.
            logger.warning("OGR enrollment failed (HTTP %s) — running unsigned", exc.code)
        except Exception as exc:  # noqa: BLE001
            logger.warning("OGR enrollment failed (%s) — running unsigned", exc)
        return False

    # -- signing ---------------------------------------------------------------
    def signature_header(self, body: bytes) -> str | None:
        """`OGR-Batch-Signature` value for this body, or None when unsigned."""
        if not self._key or not self.key_id:
            return None
        header = _b64url(json.dumps(
            {"alg": "EdDSA", "kid": self.key_id, "b64": False, "crit": ["b64"]},
            separators=(",", ":"),
        ).encode("utf-8"))
        signature = self._key.sign(header.encode("ascii") + b"." + body)
        return f"{header}..{_b64url(signature)}"
