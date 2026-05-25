#!/usr/bin/env python3
"""
Verify Upstream API Key configuration script
Help diagnose whether the xxai API key is used as an Upstream API Key incorrectly
"""

import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database.connection import get_admin_db_session
from database.models import UpstreamApiConfig
from cryptography.fernet import Fernet
from config import settings

def get_encryption_key() -> bytes:
    """Get encryption key"""
    key_file = f"{settings.data_dir}/proxy_encryption.key"
    if os.path.exists(key_file):
        with open(key_file, 'rb') as f:
            return f.read()
    else:
        raise FileNotFoundError(f"Encryption key file not found: {key_file}")

def decrypt_api_key(encrypted_api_key: str, cipher_suite) -> str:
    """Decrypt API key"""
    return cipher_suite.decrypt(encrypted_api_key.encode()).decode()

def main():
    print("=" * 80)
    print("Verify Upstream API Key configuration")
    print("=" * 80)
    print()
    
    # Get encryption key
    try:
        encryption_key = get_encryption_key()
        cipher_suite = Fernet(encryption_key)
    except Exception as e:
        print(f"❌ Failed to get encryption key: {e}")
        return 1
    
    # Query all upstream API configurations
    db = get_admin_db_session()
    try:
        configs = db.query(UpstreamApiConfig).all()
        
        if not configs:
            print("📝 No Upstream API configurations found")
            return 0
        
        print(f"Found {len(configs)} Upstream API configurations:\n")
        
        issues_found = False
        
        for config in configs:
            print(f"Configuration name: {config.config_name}")
            print(f"  UUID: {config.id}")
            print(f"  Upstream API URL: {config.api_base_url}")
            print(f"  Tenant ID: {config.tenant_id}")
            
            # Decrypt and check API key
            try:
                decrypted_key = decrypt_api_key(config.api_key_encrypted, cipher_suite)
                
                # Mask the key for display
                if len(decrypted_key) > 12:
                    masked_key = f"{decrypted_key[:8]}...{decrypted_key[-4:]}"
                else:
                    masked_key = "***"
                
                print(f"  Decrypted API Key: {masked_key}")
                
                # Check if the key looks like an xxai key (potential misconfiguration)
                if decrypted_key.startswith('sk-xxai-'):
                    print(f"  ⚠️  Warning: This API Key looks like an OpenGuardrails platform API Key (sk-xxai-)")
                    print(f"      Upstream API Key should be the API Key for the upstream service (e.g. OpenAI)")
                    print(f"      Not the API Key for accessing the OpenGuardrails platform")
                    issues_found = True
                elif decrypted_key.startswith('sk-'):
                    print(f"  ✓ API Key format is normal (starts with sk-)")
                else:
                    print(f"  ℹ️  API Key format: other format")
                
            except Exception as e:
                print(f"  ❌  Decryption failed: {e}")
                issues_found = True
            
            print()
        
        if issues_found:
            print("=" * 80)
            print("⚠️  Found potential configuration issues!")
            print()
            print("Explanation:")
            print("  • OpenGuardrails API Key (sk-xxai-xxx): Used for client access to the OpenGuardrails platform")
            print("  • Upstream API Key (e.g. sk-xxx): Stored in the configuration, used for OpenGuardrails to call the upstream service")
            print()
            print("If you incorrectly configured the key in the sk-xxai- format as an Upstream API Key,")
            print("please edit the configuration in the management interface to fill in the correct upstream service API Key.")
            print("=" * 80)
        else:
            print("=" * 80)
            print("✓ All configurations look normal")
            print("=" * 80)
        
        return 1 if issues_found else 0
        
    finally:
        db.close()

if __name__ == "__main__":
    sys.exit(main())

