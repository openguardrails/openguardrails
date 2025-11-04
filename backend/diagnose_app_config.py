#!/usr/bin/env python3
"""
Diagnostic script to check application-specific configuration isolation

This script checks:
1. How many applications exist
2. What configurations each application has
3. Whether configurations are properly isolated by application_id
"""

import sys
import os

# Ensure we're in the backend directory
os.chdir(os.path.dirname(os.path.abspath(__file__)))

from database.connection import get_db
from database.models import (
    Application, Blacklist, Whitelist, ResponseTemplate,
    RiskTypeConfig, BanPolicy, KnowledgeBase, DataSecurityEntityType
)
from sqlalchemy import func

def main():
    db = next(get_db())
    try:
        print("=" * 80)
        print("OpenGuardrails Application Configuration Isolation Diagnostic")
        print("=" * 80)

        # Check applications
        print("\n1. APPLICATIONS:")
        print("-" * 80)
        apps = db.query(Application).filter_by(is_active=True).all()
        if not apps:
            print("❌ No active applications found!")
            return

        for app in apps:
            print(f"\n  App ID: {app.id}")
            print(f"  Name: {app.name}")
            print(f"  Tenant ID: {app.tenant_id}")
            print(f"  Created: {app.created_at}")

        # Check configurations for each application
        for app in apps:
            print(f"\n\n{'=' * 80}")
            print(f"Configuration for Application: {app.name} ({app.id})")
            print(f"{'=' * 80}")

            # Blacklists
            blacklists = db.query(Blacklist).filter_by(application_id=app.id).all()
            print(f"\n  📋 Blacklists: {len(blacklists)}")
            for bl in blacklists:
                keywords = bl.keywords if isinstance(bl.keywords, list) else []
                print(f"    - {bl.name}: {len(keywords)} keywords (Active: {bl.is_active})")

            # Whitelists
            whitelists = db.query(Whitelist).filter_by(application_id=app.id).all()
            print(f"\n  ✅ Whitelists: {len(whitelists)}")
            for wl in whitelists:
                keywords = wl.keywords if isinstance(wl.keywords, list) else []
                print(f"    - {wl.name}: {len(keywords)} keywords (Active: {wl.is_active})")

            # Response Templates
            templates = db.query(ResponseTemplate).filter_by(application_id=app.id).all()
            print(f"\n  💬 Response Templates: {len(templates)}")
            for tpl in templates:
                print(f"    - Category: {tpl.category}, Default: {tpl.is_default}, Active: {tpl.is_active}")

            # Risk Type Config
            risk_config = db.query(RiskTypeConfig).filter_by(application_id=app.id).first()
            if risk_config:
                enabled_types = []
                for i in range(1, 22):
                    attr = f's{i}_enabled'
                    if hasattr(risk_config, attr) and getattr(risk_config, attr):
                        enabled_types.append(f'S{i}')
                print(f"\n  🛡️ Risk Type Config: Found")
                print(f"    - Enabled types: {', '.join(enabled_types)}")
                print(f"    - Trigger level: {risk_config.sensitivity_trigger_level}")
                print(f"    - Thresholds: Low={risk_config.low_sensitivity_threshold}, "
                      f"Med={risk_config.medium_sensitivity_threshold}, "
                      f"High={risk_config.high_sensitivity_threshold}")
            else:
                print(f"\n  🛡️ Risk Type Config: ❌ NOT FOUND")

            # Ban Policy
            ban_policy = db.query(BanPolicy).filter_by(application_id=app.id).first()
            if ban_policy:
                print(f"\n  🚫 Ban Policy: Found")
                print(f"    - Enabled: {ban_policy.enabled}")
                print(f"    - Risk level: {ban_policy.risk_level}")
                print(f"    - Trigger count: {ban_policy.trigger_count}")
                print(f"    - Time window: {ban_policy.time_window_minutes} minutes")
                print(f"    - Ban duration: {ban_policy.ban_duration_minutes} minutes")
            else:
                print(f"\n  🚫 Ban Policy: ❌ NOT FOUND")

            # Knowledge Base
            kb_entries = db.query(KnowledgeBase).filter_by(application_id=app.id).all()
            print(f"\n  📚 Knowledge Base: {len(kb_entries)} entries")

            # Data Security Entity Types
            entity_types = db.query(DataSecurityEntityType).filter_by(application_id=app.id).all()
            print(f"\n  🔐 Data Security Entity Types: {len(entity_types)}")
            for et in entity_types:
                enabled = getattr(et, 'is_enabled', getattr(et, 'enabled', True))
                print(f"    - {et.entity_type}: Enabled={enabled}")

        # Check for orphaned configurations (without application_id)
        print(f"\n\n{'=' * 80}")
        print("ORPHANED CONFIGURATIONS (no application_id)")
        print(f"{'=' * 80}")

        orphaned_blacklists = db.query(Blacklist).filter(Blacklist.application_id.is_(None)).count()
        orphaned_whitelists = db.query(Whitelist).filter(Whitelist.application_id.is_(None)).count()
        orphaned_templates = db.query(ResponseTemplate).filter(ResponseTemplate.application_id.is_(None)).count()
        orphaned_risk_configs = db.query(RiskTypeConfig).filter(RiskTypeConfig.application_id.is_(None)).count()
        orphaned_ban_policies = db.query(BanPolicy).filter(BanPolicy.application_id.is_(None)).count()

        print(f"  Blacklists: {orphaned_blacklists}")
        print(f"  Whitelists: {orphaned_whitelists}")
        print(f"  Response Templates: {orphaned_templates}")
        print(f"  Risk Type Configs: {orphaned_risk_configs}")
        print(f"  Ban Policies: {orphaned_ban_policies}")

        # Summary
        print(f"\n\n{'=' * 80}")
        print("SUMMARY")
        print(f"{'=' * 80}")
        print(f"  Total Applications: {len(apps)}")

        if len(apps) >= 2:
            app1, app2 = apps[0], apps[1]

            # Compare configurations
            bl1 = db.query(Blacklist).filter_by(application_id=app1.id).count()
            bl2 = db.query(Blacklist).filter_by(application_id=app2.id).count()

            wl1 = db.query(Whitelist).filter_by(application_id=app1.id).count()
            wl2 = db.query(Whitelist).filter_by(application_id=app2.id).count()

            tpl1 = db.query(ResponseTemplate).filter_by(application_id=app1.id).count()
            tpl2 = db.query(ResponseTemplate).filter_by(application_id=app2.id).count()

            print(f"\n  App 1 ({app1.name}):")
            print(f"    Blacklists: {bl1}, Whitelists: {wl1}, Templates: {tpl1}")

            print(f"\n  App 2 ({app2.name}):")
            print(f"    Blacklists: {bl2}, Whitelists: {wl2}, Templates: {tpl2}")

            if bl1 == bl2 and wl1 == wl2 and tpl1 == tpl2 and bl1 > 0:
                print(f"\n  ⚠️  WARNING: Both apps have the same number of configurations!")
                print(f"      This might indicate a data isolation problem.")
            else:
                print(f"\n  ✅ Apps have different configurations (expected)")

        print("\n" + "=" * 80)

    finally:
        db.close()

if __name__ == "__main__":
    main()
