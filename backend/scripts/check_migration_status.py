#!/usr/bin/env python3
"""
Check migration status and table structure
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from database.connection import admin_engine
from sqlalchemy import text

def check_migration_status():
    """Check migration status"""
    with admin_engine.connect() as conn:
        # Check migration history
        print("=== Migration History ===")
        result = conn.execute(text("""
            SELECT version, description, executed_at, success
            FROM schema_migrations
            ORDER BY version
        """))
        
        for row in result:
            status = "✅" if row[3] else "❌"
            print(f"{status} v{row[0]:03d}: {row[1]} ({row[2]})")
        
        print("\n=== Table Status ===")
        
        # Check if proxy_model_configs exists
        result = conn.execute(text("""
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'proxy_model_configs'
            )
        """))
        if result.scalar():
            print("✅ proxy_model_configs table exists")
            result = conn.execute(text("SELECT COUNT(*) FROM proxy_model_configs"))
            count = result.scalar()
            print(f"   Records: {count}")
        else:
            print("❌ proxy_model_configs table does not exist")
        
        # Check if proxy_model_configs_deprecated exists
        result = conn.execute(text("""
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'proxy_model_configs_deprecated'
            )
        """))
        if result.scalar():
            print("✅ proxy_model_configs_deprecated table exists")
            result = conn.execute(text("SELECT COUNT(*) FROM proxy_model_configs_deprecated"))
            count = result.scalar()
            print(f"   Records: {count}")
        else:
            print("❌ proxy_model_configs_deprecated table does not exist")
        
        # Check upstream_api_configs
        result = conn.execute(text("""
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'upstream_api_configs'
            )
        """))
        if result.scalar():
            print("✅ upstream_api_configs table exists")
            result = conn.execute(text("SELECT COUNT(*) FROM upstream_api_configs"))
            count = result.scalar()
            print(f"   Records: {count}")
            
            # Show sample IDs
            print("\n   Sample configurations:")
            result = conn.execute(text("""
                SELECT id, config_name, created_at
                FROM upstream_api_configs
                ORDER BY created_at
                LIMIT 5
            """))
            for row in result:
                print(f"   - {row[0]} | {row[1]} | {row[2]}")
        else:
            print("❌ upstream_api_configs table does not exist")

if __name__ == "__main__":
    check_migration_status()

