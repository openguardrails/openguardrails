#!/usr/bin/env python3
"""
Test script to verify upstream API config lookup
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from database.connection import get_admin_db_session
from database.models import UpstreamApiConfig
import uuid

def test_config_lookup(upstream_api_id_str: str, tenant_id_str: str):
    """Test the exact query used in get_upstream_api_config"""
    print(f"Testing config lookup:")
    print(f"  Upstream API ID: {upstream_api_id_str}")
    print(f"  Tenant ID: {tenant_id_str}")
    print("")
    
    try:
        upstream_api_id = uuid.UUID(upstream_api_id_str)
        tenant_id = uuid.UUID(tenant_id_str)
    except ValueError as e:
        print(f"❌ Invalid UUID: {e}")
        return
    
    db = get_admin_db_session()
    try:
        # This is the exact query from get_upstream_api_config
        config = db.query(UpstreamApiConfig).filter(
            UpstreamApiConfig.id == upstream_api_id,
            UpstreamApiConfig.tenant_id == tenant_id,
            UpstreamApiConfig.is_active == True
        ).first()
        
        if config:
            print(f"✅ Configuration found!")
            print(f"   Name: {config.config_name}")
            print(f"   Provider: {config.provider}")
            print(f"   API Base URL: {config.api_base_url}")
            print(f"   Is Active: {config.is_active}")
        else:
            print(f"❌ Configuration NOT found with these filters:")
            print("")
            
            # Check each filter separately
            print("Checking filters individually:")
            
            # Check if config exists by ID only
            config_by_id = db.query(UpstreamApiConfig).filter(
                UpstreamApiConfig.id == upstream_api_id
            ).first()
            if config_by_id:
                print(f"  ✅ Config exists with ID {upstream_api_id}")
                print(f"     But tenant_id is: {config_by_id.tenant_id}")
                print(f"     Expected tenant_id: {tenant_id}")
                print(f"     Is Active: {config_by_id.is_active}")
            else:
                print(f"  ❌ Config with ID {upstream_api_id} does not exist")
            
    finally:
        db.close()

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python backend/scripts/test_config_lookup.py <upstream_api_id> <tenant_id>")
        sys.exit(1)
    
    upstream_api_id = sys.argv[1]
    tenant_id = sys.argv[2]
    test_config_lookup(upstream_api_id, tenant_id)

