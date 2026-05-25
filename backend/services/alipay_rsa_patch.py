"""
Monkey patch for alipay-sdk-python to fix RSA signing issues in Python 3.11+

The official alipay-sdk-python uses the `rsa` library which has compatibility
issues with Python 3.11+. This patch replaces the signing functions with
implementations using the `cryptography` library.
"""
import base64
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.backends import default_backend
from typing import Union


def sign_with_rsa2_cryptography(private_key_pem: Union[str, bytes], sign_content: Union[str, bytes], charset: str = 'utf-8') -> str:
    """
    Sign content using RSA SHA256 with cryptography library

    Args:
        private_key_pem: PEM formatted private key
        sign_content: Content to sign (str or bytes)
        charset: Character encoding

    Returns:
        Base64 encoded signature
    """
    if isinstance(private_key_pem, str):
        private_key_pem = private_key_pem.encode(charset)

    # Ensure sign_content is bytes
    if isinstance(sign_content, str):
        sign_content = sign_content.encode(charset)

    # Load private key
    private_key = serialization.load_pem_private_key(
        private_key_pem,
        password=None,
        backend=default_backend()
    )

    # Sign the content
    signature = private_key.sign(
        sign_content,
        padding.PKCS1v15(),
        hashes.SHA256()
    )

    # Return base64 encoded signature
    return base64.b64encode(signature).decode(charset)


def verify_with_rsa_cryptography(public_key_pem: Union[str, bytes], sign_content: bytes, signature: str) -> bool:
    """
    Verify RSA signature using cryptography library

    Args:
        public_key_pem: PEM formatted public key
        sign_content: Original content that was signed
        signature: Base64 encoded signature to verify

    Returns:
        True if signature is valid
    """
    if isinstance(public_key_pem, str):
        public_key_pem = public_key_pem.encode('utf-8')

    # Load public key
    public_key = serialization.load_pem_public_key(
        public_key_pem,
        backend=default_backend()
    )

    # Decode signature from base64
    signature_bytes = base64.b64decode(signature)

    # Verify signature
    try:
        public_key.verify(
            signature_bytes,
            sign_content,
            padding.PKCS1v15(),
            hashes.SHA256()
        )
        return True
    except Exception:
        return False


def apply_alipay_rsa_patch():
    """
    Apply the monkey patch to alipay.aop.api.util.SignatureUtils

    This replaces the sign_with_rsa2 and verify_with_rsa functions with
    implementations using the cryptography library instead of the rsa library.
    """
    try:
        import alipay.aop.api.util.SignatureUtils as sig_utils

        # Replace the module-level functions (not class methods)
        sig_utils.sign_with_rsa2 = sign_with_rsa2_cryptography
        sig_utils.verify_with_rsa = verify_with_rsa_cryptography

        print("✅ Alipay RSA patch applied successfully")
        return True
    except ImportError as e:
        print(f"⚠️ Could not apply Alipay RSA patch: {e}")
        return False
