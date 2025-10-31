#!/usr/bin/env python3
"""
验证 Upstream API Key 配置的脚本
帮助诊断是否错误地使用了 xxai API key 作为 Upstream API Key
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
    print("验证 Upstream API Key 配置")
    print("=" * 80)
    print()
    
    # Get encryption key
    try:
        encryption_key = get_encryption_key()
        cipher_suite = Fernet(encryption_key)
    except Exception as e:
        print(f"❌ 无法获取加密密钥: {e}")
        return 1
    
    # Query all upstream API configurations
    db = get_admin_db_session()
    try:
        configs = db.query(UpstreamApiConfig).all()
        
        if not configs:
            print("📝 没有找到任何 Upstream API 配置")
            return 0
        
        print(f"找到 {len(configs)} 个 Upstream API 配置：\n")
        
        issues_found = False
        
        for config in configs:
            print(f"配置名称: {config.config_name}")
            print(f"  UUID: {config.id}")
            print(f"  上游 API URL: {config.api_base_url}")
            print(f"  租户 ID: {config.tenant_id}")
            
            # Decrypt and check API key
            try:
                decrypted_key = decrypt_api_key(config.api_key_encrypted, cipher_suite)
                
                # Mask the key for display
                if len(decrypted_key) > 12:
                    masked_key = f"{decrypted_key[:8]}...{decrypted_key[-4:]}"
                else:
                    masked_key = "***"
                
                print(f"  解密后的 API Key: {masked_key}")
                
                # Check if the key looks like an xxai key (potential misconfiguration)
                if decrypted_key.startswith('sk-xxai-'):
                    print(f"  ⚠️  警告: 这个 API Key 看起来像 OpenGuardrails 平台的 API Key (sk-xxai-)")
                    print(f"      Upstream API Key 应该是上游服务（如 OpenAI）的 API Key")
                    print(f"      而不是用于访问 OpenGuardrails 平台的 API Key")
                    issues_found = True
                elif decrypted_key.startswith('sk-'):
                    print(f"  ✓ API Key 格式正常 (以 sk- 开头)")
                else:
                    print(f"  ℹ️  API Key 格式: 其他格式")
                
            except Exception as e:
                print(f"  ❌ 解密失败: {e}")
                issues_found = True
            
            print()
        
        if issues_found:
            print("=" * 80)
            print("⚠️  发现潜在的配置问题！")
            print()
            print("说明：")
            print("  • OpenGuardrails API Key (sk-xxai-xxx)：用于客户端访问 OpenGuardrails 平台")
            print("  • Upstream API Key (如 sk-xxx)：存储在配置中，用于 OpenGuardrails 调用上游服务")
            print()
            print("如果你错误地将 sk-xxai- 格式的 key 配置为 Upstream API Key，")
            print("请在管理界面重新编辑配置，填入正确的上游服务 API Key。")
            print("=" * 80)
        else:
            print("=" * 80)
            print("✓ 所有配置看起来正常")
            print("=" * 80)
        
        return 1 if issues_found else 0
        
    finally:
        db.close()

if __name__ == "__main__":
    sys.exit(main())

