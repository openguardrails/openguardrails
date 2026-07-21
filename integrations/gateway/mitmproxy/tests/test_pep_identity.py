"""PEP identity: keyfile persistence, detached-JWS shape, signature validity."""
import base64
import json

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from ogr_mitmproxy.pep_identity import PepIdentity


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "==")


def test_keypair_persists_across_instances(tmp_path):
    keyfile = tmp_path / "key.json"
    first = PepIdentity(keyfile=str(keyfile))
    second = PepIdentity(keyfile=str(keyfile))
    assert first.public_key_b64url() == second.public_key_b64url()
    assert keyfile.stat().st_mode & 0o777 == 0o600


def test_unenrolled_identity_does_not_sign(tmp_path):
    ident = PepIdentity(keyfile=str(tmp_path / "key.json"))
    assert ident.signature_header(b"{}") is None  # no key_id before enrollment


def test_signature_header_verifies_against_public_key(tmp_path):
    ident = PepIdentity(keyfile=str(tmp_path / "key.json"))
    ident.key_id = "deadbeef00112233"  # as returned by /enroll
    body = b'{"batch":[{"event_id":"e1"}]}'
    value = ident.signature_header(body)
    header_b64, empty, sig_b64 = value.split(".")
    assert empty == ""  # detached payload slot

    header = json.loads(_b64d(header_b64))
    assert header == {"alg": "EdDSA", "kid": "deadbeef00112233",
                      "b64": False, "crit": ["b64"]}

    public = Ed25519PublicKey.from_public_bytes(_b64d(ident.public_key_b64url()))
    public.verify(_b64d(sig_b64), header_b64.encode("ascii") + b"." + body)

    # A tampered body must not verify.
    import pytest
    from cryptography.exceptions import InvalidSignature
    with pytest.raises(InvalidSignature):
        public.verify(_b64d(sig_b64), header_b64.encode("ascii") + b"." + b"{}")
