#!/usr/bin/env python3
"""
Check all API keys and authentication tokens for a user
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from database.connection import get_admin_db_session
from database.models import Tenant
from sqlalchemy import func

def check_auth_tokens(email: str):
    """Check all API keys for a user"""
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
        print(f"   API Key: {tenant.api_key}")
        print(f"   Is Active: {tenant.is_active}")
        print(f"   Is Verified: {tenant.is_verified}")
        print("")
        
        # Check if there are other tenants with similar email
        similar_tenants = db.query(Tenant).filter(
            Tenant.email.ilike(f"%{email.split('@')[0]}%")
        ).all()
        
        if len(similar_tenants) > 1:
            print(f"⚠️  Found {len(similar_tenants)} tenants with similar email:")
            for t in similar_tenants:
                print(f"   - {t.email} (ID: {t.id}, API Key: {t.api_key})")
            print("")
            
    finally:
        db.close()

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python backend/scripts/check_auth_tokens.py <email>")
        sys.exit(1)
    
    email = sys.argv[1]
    check_auth_tokens(email)

