#!/usr/bin/env python3
"""
Check if a specific upstream API config ID exists in both old and new tables
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from database.connection import admin_engine
from sqlalchemy import text
import uuid

def check_specific_id(config_id_str: str):
    """Check if a specific ID exists"""
    try:
        config_id = uuid.UUID(config_id_str)
    except ValueError:
        print(f"❌ Invalid UUID: {config_id_str}")
        return
    
    print(f"Searching for ID: {config_id}\n")
    
    with admin_engine.connect() as conn:
        # Check in upstream_api_configs
        print("=== upstream_api_configs ===")
        result = conn.execute(text("""
            SELECT id, tenant_id, config_name, api_base_url, is_active, created_at
            FROM upstream_api_configs
            WHERE id = :config_id
        """), {"config_id": config_id})
        
        row = result.fetchone()
        if row:
            print(f"✅ Found in upstream_api_configs:")
            print(f"   ID: {row[0]}")
            print(f"   Tenant ID: {row[1]}")
            print(f"   Config Name: {row[2]}")
            print(f"   API Base URL: {row[3]}")
            print(f"   Is Active: {row[4]}")
            print(f"   Created At: {row[5]}")
        else:
            print(f"❌ Not found in upstream_api_configs")
        
        print("\n=== proxy_model_configs_deprecated ===")
        result = conn.execute(text("""
            SELECT id, tenant_id, config_name, api_base_url, enabled, created_at
            FROM proxy_model_configs_deprecated
            WHERE id = :config_id
        """), {"config_id": config_id})
        
        row = result.fetchone()
        if row:
            print(f"✅ Found in proxy_model_configs_deprecated:")
            print(f"   ID: {row[0]}")
            print(f"   Tenant ID: {row[1]}")
            print(f"   Config Name: {row[2]}")
            print(f"   API Base URL: {row[3]}")
            print(f"   Enabled: {row[4]}")
            print(f"   Created At: {row[5]}")
        else:
            print(f"❌ Not found in proxy_model_configs_deprecated")
        
        # Check if there are any configs for the user with this API base URL
        if row:
            tenant_id = row[1]
            api_base_url = row[3]
            print(f"\n=== Looking for migrated configs ===")
            print(f"   Tenant: {tenant_id}")
            print(f"   API Base URL: {api_base_url}")
            
            result = conn.execute(text("""
                SELECT id, config_name, api_base_url, is_active
                FROM upstream_api_configs
                WHERE tenant_id = :tenant_id 
                AND api_base_url = :api_base_url
            """), {"tenant_id": tenant_id, "api_base_url": api_base_url})
            
            for row in result:
                print(f"\n✅ Found migrated config:")
                print(f"   NEW ID: {row[0]}")
                print(f"   Config Name: {row[1]}")
                print(f"   API Base URL: {row[2]}")
                print(f"   Is Active: {row[3]}")

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python backend/scripts/check_specific_id.py <upstream_api_id>")
        sys.exit(1)
    
    config_id = sys.argv[1]
    check_specific_id(config_id)

