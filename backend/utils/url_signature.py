"""
URL signature tool

Used to generate and verify URL signatures with expiration time, protect media resource access security.
"""
import hmac
import hashlib
import time
from typing import Optional
from config import settings


def generate_media_url_signature(
    tenant_id: str,
    filename: str,
    expires_in_seconds: int = 3600
) -> tuple[str, int]:
    """
    Generate signature and expiration time for media file access

    Args:
        tenant_id: User ID
        filename: File name
        expires_in_seconds: Signature expiration time (seconds), default 1 hour

    Returns:
        (signature, expires_timestamp) Tuple
    """
    expires = int(time.time()) + expires_in_seconds

    # Build signature string: tenant_id|filename|expires
    message = f"{tenant_id}|{filename}|{expires}"

    # Generate signature using HMAC-SHA256
    signature = hmac.new(
        settings.jwt_secret_key.encode(),
        message.encode(),
        hashlib.sha256
    ).hexdigest()

    return signature, expires


def verify_media_url_signature(
    tenant_id: str,
    filename: str,
    signature: str,
    expires: int
) -> bool:
    """
    Verify media file access signature

    Args:
        tenant_id: User ID
        filename: File name
        signature: Signature
        expires: Expiration time stamp

    Returns:
        Whether verification passes
    """
    # Check if expired
    if int(time.time()) > expires:
        return False

    # Recalculate signature
    message = f"{tenant_id}|{filename}|{expires}"
    expected_signature = hmac.new(
        settings.jwt_secret_key.encode(),
        message.encode(),
        hashlib.sha256
    ).hexdigest()

    # Use constant time comparison to prevent timing attacks
    return hmac.compare_digest(signature, expected_signature)


def generate_signed_media_url(
    tenant_id: str,
    filename: str,
    base_url: str = "/api/v1/media/image",
    expires_in_seconds: int = 3600
) -> str:
    """
    Generate complete media URL with signature

    Args:
        tenant_id: User ID
        filename: File name
        base_url: Base URL path
        expires_in_seconds: Signature expiration time (seconds)

    Returns:
        Complete URL with signature
    """
    signature, expires = generate_media_url_signature(
        tenant_id, filename, expires_in_seconds
    )

    return f"{base_url}/{tenant_id}/{filename}?token={signature}&expires={expires}"