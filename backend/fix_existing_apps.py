#!/usr/bin/env python3
"""
Migration script to add default configurations to existing applications
that don't have them.

This fixes applications created before the application initialization feature
was added.
"""

import sys
import os

# Ensure we're in the backend directory
os.chdir(os.path.dirname(os.path.abspath(__file__)))

from database.connection import get_db
from database.models import (
    Application, RiskTypeConfig, BanPolicy, DataSecurityEntityType
)
from utils.logger import setup_logger

logger = setup_logger()

def initialize_application_configs(db, application_id: str, tenant_id: str):
    """
    Initialize default configurations for an application

    This creates:
    - RiskTypeConfig (all risk types enabled by default)
    - BanPolicy (disabled by default)
    - DataSecurityEntityTypes (system entity types enabled)
    """
    # 1. Create RiskTypeConfig if not exists
    existing_risk_config = db.query(RiskTypeConfig).filter_by(application_id=application_id).first()
    if not existing_risk_config:
        risk_config = RiskTypeConfig(
            application_id=application_id,
            tenant_id=tenant_id,
            s1_enabled=True, s2_enabled=True, s3_enabled=True, s4_enabled=True,
            s5_enabled=True, s6_enabled=True, s7_enabled=True, s8_enabled=True,
            s9_enabled=True, s10_enabled=True, s11_enabled=True, s12_enabled=True,
            s13_enabled=True, s14_enabled=True, s15_enabled=True, s16_enabled=True,
            s17_enabled=True, s18_enabled=True, s19_enabled=True, s20_enabled=True,
            s21_enabled=True,
            low_sensitivity_threshold=0.95,
            medium_sensitivity_threshold=0.60,
            high_sensitivity_threshold=0.40,
            sensitivity_trigger_level="medium"
        )
        db.add(risk_config)
        logger.info(f"  ✓ Created RiskTypeConfig")
    else:
        logger.info(f"  ✓ RiskTypeConfig already exists")

    # 2. Create BanPolicy if not exists
    existing_ban_policy = db.query(BanPolicy).filter_by(application_id=application_id).first()
    if not existing_ban_policy:
        ban_policy = BanPolicy(
            application_id=application_id,
            tenant_id=tenant_id,
            enabled=False,
            risk_level='high_risk',
            trigger_count=3,
            time_window_minutes=10,
            ban_duration_minutes=1440  # 24 hours
        )
        db.add(ban_policy)
        logger.info(f"  ✓ Created BanPolicy")
    else:
        logger.info(f"  ✓ BanPolicy already exists")

    # 3. Copy DataSecurityEntityTypes from system templates
    # Check if application already has entity types
    existing_entity_types = db.query(DataSecurityEntityType).filter_by(
        application_id=application_id
    ).all()

    if not existing_entity_types:
        # Get system templates (source_type = 'system_template' and application_id is NULL)
        system_templates = db.query(DataSecurityEntityType).filter(
            DataSecurityEntityType.source_type == 'system_template',
            DataSecurityEntityType.application_id.is_(None)
        ).all()

        if system_templates:
            for template in system_templates:
                # Copy system template to this application
                copy = DataSecurityEntityType(
                    tenant_id=tenant_id,
                    application_id=application_id,
                    entity_type=template.entity_type,
                    display_name=template.display_name,
                    category=template.category,
                    recognition_method=template.recognition_method,
                    recognition_config=(template.recognition_config or {}).copy() if isinstance(template.recognition_config, dict) else {},
                    anonymization_method=template.anonymization_method,
                    anonymization_config=(template.anonymization_config or {}).copy() if isinstance(template.anonymization_config, dict) else {},
                    is_active=True,
                    is_global=False,
                    source_type='system_copy',
                    template_id=template.id
                )
                db.add(copy)

            logger.info(f"  ✓ Created {len(system_templates)} DataSecurityEntityTypes from system templates")
        else:
            logger.warning(f"  ⚠️  No system templates found for DataSecurityEntityTypes")
    else:
        logger.info(f"  ✓ DataSecurityEntityTypes already exist ({len(existing_entity_types)})")

def main():
    db = next(get_db())
    try:
        print("=" * 80)
        print("Fix Existing Applications - Add Missing Configurations")
        print("=" * 80)

        # Get all active applications
        apps = db.query(Application).filter_by(is_active=True).all()
        if not apps:
            print("❌ No active applications found!")
            return

        print(f"\nFound {len(apps)} active application(s)")

        # Process each application
        fixed_count = 0
        for app in apps:
            print(f"\n{'─' * 80}")
            print(f"Processing: {app.name} ({app.id})")
            print(f"{'─' * 80}")

            # Check if configs exist
            risk_config = db.query(RiskTypeConfig).filter_by(application_id=app.id).first()
            ban_policy = db.query(BanPolicy).filter_by(application_id=app.id).first()
            entity_types = db.query(DataSecurityEntityType).filter_by(application_id=app.id).count()

            needs_fix = False
            if not risk_config:
                print("  ⚠️  Missing RiskTypeConfig")
                needs_fix = True
            if not ban_policy:
                print("  ⚠️  Missing BanPolicy")
                needs_fix = True
            if entity_types == 0:
                print("  ⚠️  Missing DataSecurityEntityTypes")
                needs_fix = True

            if needs_fix:
                print(f"\n  🔧 Initializing missing configurations...")
                try:
                    initialize_application_configs(db, str(app.id), str(app.tenant_id))
                    db.commit()
                    print(f"  ✅ Successfully fixed application: {app.name}")
                    fixed_count += 1
                except Exception as e:
                    logger.error(f"  ❌ Failed to fix application {app.name}: {e}")
                    db.rollback()
            else:
                print("  ✅ All configurations exist")

        print(f"\n{'=' * 80}")
        print(f"SUMMARY")
        print(f"{'=' * 80}")
        print(f"  Total applications: {len(apps)}")
        print(f"  Fixed applications: {fixed_count}")
        print(f"  Already complete: {len(apps) - fixed_count}")
        print()

    finally:
        db.close()

if __name__ == "__main__":
    main()
