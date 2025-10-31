#!/usr/bin/env python3
"""
Diagnostic script to find user's upstream API configuration after migration
Usage: python backend/scripts/find_user_config.py <email>
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from database.connection import get_admin_db_session
from database.models import Tenant, UpstreamApiConfig
from sqlalchemy import func

def find_user_configs(email: str):
    """Find all upstream API configurations for a user by email"""
    db = get_admin_db_session()
    try:
        # Find tenant by email
        tenant = db.query(Tenant).filter(
            func.lower(Tenant.email) == email.lower()
        ).first()
        
        if not tenant:
            print(f"❌ User not found: {email}")
            return
        
        print(f"✅ Found user: {email}")
        print(f"   Tenant ID: {tenant.id}")
        print(f"   Is Active: {tenant.is_active}")
        print("")
        
        # Find all upstream API configurations for this tenant
        configs = db.query(UpstreamApiConfig).filter(
            UpstreamApiConfig.tenant_id == tenant.id
        ).order_by(UpstreamApiConfig.created_at).all()
        
        if not configs:
            print("❌ No upstream API configurations found for this user")
            return
        
        print(f"📋 Found {len(configs)} upstream API configuration(s):")
        print("")
        
        for i, config in enumerate(configs, 1):
            print(f"Configuration #{i}:")
            print(f"   ID: {config.id}")
            print(f"   Name: {config.config_name}")
            print(f"   Provider: {config.provider or 'N/A'}")
            print(f"   API Base URL: {config.api_base_url}")
            print(f"   Is Active: {config.is_active}")
            print(f"   Description: {config.description or 'N/A'}")
            print(f"   Created: {config.created_at}")
            print(f"   Gateway URL: http://localhost:5002/v1/gateway/{config.id}/chat/completions")
            print("")
            
    finally:
        db.close()

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python backend/scripts/find_user_config.py <email>")
        sys.exit(1)
    
    email = sys.argv[1]
    find_user_configs(email)

