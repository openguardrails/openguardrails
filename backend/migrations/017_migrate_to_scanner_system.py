"""
Migration: Migrate from hardcoded risk types to scanner package system
Version: 017
Date: 2025-11-05

This migration:
1. Loads built-in scanner packages from JSON files
2. Migrates existing risk_type_config data to application_scanner_configs
3. Preserves user enable/disable settings
"""

import json
import os
import sys
from pathlib import Path

# Add backend to path
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

from sqlalchemy import create_engine, text, func
from sqlalchemy.orm import Session
from database.connection import get_database_url
from utils.logger import setup_logger

# Setup logger
logger = setup_logger()


# Risk level mapping from old system
RISK_LEVEL_MAP = {
    'S1': 'low_risk',
    'S2': 'high_risk',
    'S3': 'high_risk',
    'S4': 'medium_risk',
    'S5': 'high_risk',
    'S6': 'medium_risk',
    'S7': 'medium_risk',
    'S8': 'low_risk',
    'S9': 'high_risk',
    'S10': 'low_risk',
    'S11': 'low_risk',
    'S12': 'low_risk',
    'S13': 'low_risk',
    'S14': 'low_risk',
    'S15': 'high_risk',
    'S16': 'medium_risk',
    'S17': 'high_risk',
    'S18': 'low_risk',
    'S19': 'low_risk',
    'S20': 'low_risk',
    'S21': 'low_risk',
}


def load_builtin_packages(db: Session):
    """Load built-in packages from JSON files."""
    logger.info("Loading built-in scanner packages...")

    # Try multiple locations for built-in packages
    possible_dirs = [
        backend_dir / 'builtin_scanners',
        backend_dir.parent / 'docs' / 'scanner_packages_examples',  # Fallback to examples
    ]

    builtin_dir = None
    for dir_path in possible_dirs:
        if dir_path.exists():
            builtin_dir = dir_path
            logger.info(f"Using built-in packages from: {builtin_dir}")
            break

    if not builtin_dir:
        logger.error(f"Built-in scanners directory not found in any of: {possible_dirs}")
        raise FileNotFoundError("Built-in scanner packages not found")

    package_files = [
        builtin_dir / 'restricted_topics.json',
        builtin_dir / 'sensitive_topics.json'
    ]

    loaded_packages = []

    for package_file in package_files:
        if not package_file.exists():
            logger.warning(f"Package file not found: {package_file}")
            continue

        try:
            with open(package_file, 'r', encoding='utf-8') as f:
                package_data = json.load(f)

            package_code = package_data['package_code']

            # Check if package already exists
            result = db.execute(
                text("SELECT id FROM scanner_packages WHERE package_code = :code"),
                {'code': package_code}
            )
            existing = result.fetchone()

            if existing:
                logger.info(f"Package '{package_code}' already exists, skipping...")
                continue

            # Insert package
            result = db.execute(
                text("""
                    INSERT INTO scanner_packages (
                        package_code, package_name, author, description,
                        version, license, package_type, is_official,
                        requires_purchase, is_active, scanner_count
                    ) VALUES (
                        :code, :name, :author, :description,
                        :version, :license, 'builtin', TRUE,
                        FALSE, TRUE, :count
                    )
                    RETURNING id
                """),
                {
                    'code': package_data['package_code'],
                    'name': package_data['package_name'],
                    'author': package_data.get('author', 'OpenGuardrails'),
                    'description': package_data.get('description'),
                    'version': package_data.get('version', '1.0.0'),
                    'license': package_data.get('license', 'proprietary'),
                    'count': len(package_data['scanners'])
                }
            )
            package_id = result.fetchone()[0]

            # Insert scanners
            for i, scanner_data in enumerate(package_data['scanners']):
                db.execute(
                    text("""
                        INSERT INTO scanners (
                            package_id, tag, name, description,
                            scanner_type, definition,
                            default_risk_level, default_scan_prompt, default_scan_response,
                            is_active, display_order
                        ) VALUES (
                            :package_id, :tag, :name, :description,
                            :type, :definition,
                            :risk_level, :scan_prompt, :scan_response,
                            TRUE, :order
                        )
                    """),
                    {
                        'package_id': package_id,
                        'tag': scanner_data['tag'],
                        'name': scanner_data['name'],
                        'description': scanner_data.get('description', scanner_data['definition']),
                        'type': scanner_data['type'],
                        'definition': scanner_data['definition'],
                        'risk_level': scanner_data['risk_level'],
                        'scan_prompt': scanner_data.get('scan_prompt', True),
                        'scan_response': scanner_data.get('scan_response', True),
                        'order': i
                    }
                )

            loaded_packages.append(package_data['package_name'])
            logger.info(f"✓ Created package: {package_data['package_name']} ({len(package_data['scanners'])} scanners)")

        except Exception as e:
            logger.error(f"Failed to load package {package_file}: {e}")
            raise

    db.commit()
    logger.info(f"Successfully loaded {len(loaded_packages)} built-in packages")


def migrate_risk_type_configs(db: Session):
    """Migrate existing risk_type_config to application_scanner_configs."""
    logger.info("Migrating existing risk type configurations...")

    # Get all risk type configs
    result = db.execute(text("SELECT id, application_id, tenant_id FROM risk_type_config"))
    risk_configs = result.fetchall()

    if not risk_configs:
        logger.info("No existing risk type configs to migrate")
        return

    # Get scanner ID mapping
    result = db.execute(text("SELECT tag, id FROM scanners WHERE tag LIKE 'S%' ORDER BY tag"))
    scanner_map = {row[0]: row[1] for row in result.fetchall()}

    migrated_count = 0
    skipped_count = 0

    for config in risk_configs:
        config_id = config[0]
        application_id = config[1]
        tenant_id = config[2]

        # Check if already migrated
        result = db.execute(
            text("SELECT COUNT(*) FROM application_scanner_configs WHERE application_id = :app_id"),
            {'app_id': application_id}
        )
        existing_count = result.fetchone()[0]

        if existing_count > 0:
            logger.debug(f"Application {application_id} already migrated, skipping...")
            skipped_count += 1
            continue

        # Get the enabled states for S1-S21
        result = db.execute(
            text("SELECT * FROM risk_type_config WHERE id = :id"),
            {'id': config_id}
        )
        config_row = result.fetchone()

        if not config_row:
            continue

        # Create column name to value mapping
        column_names = result.keys()
        config_dict = dict(zip(column_names, config_row))

        # Migrate S1-S21 enabled states
        for i in range(1, 22):
            tag = f'S{i}'
            enabled_field = f's{i}_enabled'

            # Get enabled state (default True if field doesn't exist)
            is_enabled = config_dict.get(enabled_field, True)

            # Get scanner ID
            scanner_id = scanner_map.get(tag)
            if not scanner_id:
                logger.warning(f"Scanner {tag} not found, skipping...")
                continue

            # Insert application_scanner_config
            db.execute(
                text("""
                    INSERT INTO application_scanner_configs (
                        application_id, scanner_id, is_enabled,
                        risk_level_override, scan_prompt_override, scan_response_override
                    ) VALUES (
                        :app_id, :scanner_id, :enabled,
                        NULL, NULL, NULL
                    )
                    ON CONFLICT (application_id, scanner_id) DO NOTHING
                """),
                {
                    'app_id': application_id,
                    'scanner_id': scanner_id,
                    'enabled': is_enabled
                }
            )

        migrated_count += 1

        if migrated_count % 10 == 0:
            logger.info(f"Migrated {migrated_count}/{len(risk_configs)} applications...")

    db.commit()
    logger.info(f"Migration complete: {migrated_count} applications migrated, {skipped_count} skipped")


def run_migration():
    """Main migration function."""
    logger.info("=" * 60)
    logger.info("Scanner Package System Migration - Python Script")
    logger.info("=" * 60)

    database_url = get_database_url()
    engine = create_engine(database_url)
    db = Session(engine)

    try:
        logger.info("\nStep 1: Loading built-in packages...")
        load_builtin_packages(db)

        logger.info("\nStep 2: Migrating existing risk type configurations...")
        migrate_risk_type_configs(db)

        logger.info("\n" + "=" * 60)
        logger.info("✓ Migration completed successfully!")
        logger.info("=" * 60)

    except Exception as e:
        db.rollback()
        logger.error(f"\n❌ Migration failed: {e}")
        import traceback
        traceback.print_exc()
        raise
    finally:
        db.close()


if __name__ == '__main__':
    run_migration()
