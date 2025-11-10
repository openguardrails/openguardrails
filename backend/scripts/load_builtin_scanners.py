#!/usr/bin/env python3
"""
Load Built-in Scanner Packages to Database

This script loads the built-in scanner packages (S1-S21) from JSON files
into the database, creating scanner_packages, scanners, and application_scanner_configs.
"""
import os
import sys
import json
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

from database.connection import get_db_session
from database.models import (
    ScannerPackage, Scanner, ApplicationScannerConfig,
    Application, Tenant, RiskTypeConfig
)
from utils.logger import setup_logger

logger = setup_logger()


def load_package_from_file(file_path: str) -> dict:
    """Load package JSON from file"""
    with open(file_path, 'r', encoding='utf-8') as f:
        return json.load(f)


def create_or_update_package(db, package_data: dict) -> ScannerPackage:
    """Create or update scanner package"""
    package_code = package_data['package_code']

    # Check if package already exists
    existing_package = db.query(ScannerPackage).filter(
        ScannerPackage.package_code == package_code
    ).first()

    if existing_package:
        logger.info(f"Package {package_code} already exists, updating...")
        # Update existing package
        existing_package.package_name = package_data['package_name']
        existing_package.author = package_data['author']
        existing_package.description = package_data['description']
        existing_package.version = package_data['version']
        existing_package.license = package_data.get('license', 'Apache-2.0')
        existing_package.package_type = 'builtin'
        existing_package.is_active = True
        db.flush()
        return existing_package
    else:
        # Create new package
        package = ScannerPackage(
            package_code=package_code,
            package_name=package_data['package_name'],
            author=package_data['author'],
            description=package_data['description'],
            version=package_data['version'],
            license=package_data.get('license', 'Apache-2.0'),
            package_type='builtin',
            is_active=True
        )
        db.add(package)
        db.flush()
        logger.info(f"Created package: {package_code} (ID: {package.id})")
        return package


def create_or_update_scanners(db, package_id: str, scanners_data: list) -> list:
    """Create or update scanners for a package"""
    created_scanners = []

    for scanner_data in scanners_data:
        tag = scanner_data['tag']

        # Check if scanner already exists
        existing_scanner = db.query(Scanner).filter(
            Scanner.tag == tag,
            Scanner.package_id == package_id
        ).first()

        if existing_scanner:
            logger.info(f"Scanner {tag} already exists, updating...")
            # Update existing scanner
            existing_scanner.scanner_type = scanner_data['type']
            existing_scanner.name = scanner_data['name']
            existing_scanner.definition = scanner_data['definition']
            existing_scanner.default_risk_level = scanner_data['risk_level']
            existing_scanner.default_scan_prompt = scanner_data.get('scan_prompt', True)
            existing_scanner.default_scan_response = scanner_data.get('scan_response', False)
            existing_scanner.is_active = True
            db.flush()
            created_scanners.append(existing_scanner)
        else:
            # Create new scanner
            scanner = Scanner(
                package_id=package_id,
                tag=tag,
                scanner_type=scanner_data['type'],
                name=scanner_data['name'],
                definition=scanner_data['definition'],
                default_risk_level=scanner_data['risk_level'],
                default_scan_prompt=scanner_data.get('scan_prompt', True),
                default_scan_response=scanner_data.get('scan_response', False),
                is_active=True
            )
            db.add(scanner)
            db.flush()
            logger.info(f"Created scanner: {tag} - {scanner_data['name']} (ID: {scanner.id})")
            created_scanners.append(scanner)

    return created_scanners


def initialize_scanner_configs_for_applications(db, scanners: list):
    """Initialize scanner configs for all existing applications based on risk_type_config"""
    # Get all applications
    applications = db.query(Application).filter(Application.is_active == True).all()

    logger.info(f"Found {len(applications)} active applications")

    for app in applications:
        logger.info(f"Initializing scanner configs for application: {app.name} (ID: {app.id})")

        # Get existing risk_type_config for this application
        risk_config = db.query(RiskTypeConfig).filter(
            RiskTypeConfig.application_id == app.id
        ).first()

        # Build enabled state mapping from risk_type_config
        enabled_map = {}
        if risk_config:
            # Map S1-S21 enabled states from risk_type_config
            enabled_map = {
                'S1': risk_config.s1_enabled if hasattr(risk_config, 's1_enabled') else True,
                'S2': risk_config.s2_enabled if hasattr(risk_config, 's2_enabled') else True,
                'S3': risk_config.s3_enabled if hasattr(risk_config, 's3_enabled') else True,
                'S4': risk_config.s4_enabled if hasattr(risk_config, 's4_enabled') else True,
                'S5': risk_config.s5_enabled if hasattr(risk_config, 's5_enabled') else True,
                'S6': risk_config.s6_enabled if hasattr(risk_config, 's6_enabled') else True,
                'S7': risk_config.s7_enabled if hasattr(risk_config, 's7_enabled') else True,
                'S8': risk_config.s8_enabled if hasattr(risk_config, 's8_enabled') else True,
                'S9': risk_config.s9_enabled if hasattr(risk_config, 's9_enabled') else True,
                'S10': risk_config.s10_enabled if hasattr(risk_config, 's10_enabled') else True,
                'S11': risk_config.s11_enabled if hasattr(risk_config, 's11_enabled') else True,
                'S12': risk_config.s12_enabled if hasattr(risk_config, 's12_enabled') else True,
                'S13': risk_config.s13_enabled if hasattr(risk_config, 's13_enabled') else True,
                'S14': risk_config.s14_enabled if hasattr(risk_config, 's14_enabled') else True,
                'S15': risk_config.s15_enabled if hasattr(risk_config, 's15_enabled') else True,
                'S16': risk_config.s16_enabled if hasattr(risk_config, 's16_enabled') else True,
                'S17': risk_config.s17_enabled if hasattr(risk_config, 's17_enabled') else True,
                'S18': risk_config.s18_enabled if hasattr(risk_config, 's18_enabled') else True,
                'S19': risk_config.s19_enabled if hasattr(risk_config, 's19_enabled') else True,
                'S20': risk_config.s20_enabled if hasattr(risk_config, 's20_enabled') else True,
                'S21': risk_config.s21_enabled if hasattr(risk_config, 's21_enabled') else True,
            }
            logger.info(f"  Found existing risk_type_config, using configured enabled states")
        else:
            # No risk_type_config found, default to all enabled
            logger.info(f"  No risk_type_config found, defaulting to all enabled")

        for scanner in scanners:
            # Check if config already exists
            existing_config = db.query(ApplicationScannerConfig).filter(
                ApplicationScannerConfig.application_id == app.id,
                ApplicationScannerConfig.scanner_id == scanner.id
            ).first()

            if existing_config:
                logger.debug(f"  Config already exists for scanner {scanner.tag}")
                continue

            # Get enabled state from risk_type_config if available, otherwise default to True
            is_enabled = enabled_map.get(scanner.tag, True) if enabled_map else True

            # Create new config with settings from risk_type_config
            config = ApplicationScannerConfig(
                application_id=app.id,
                scanner_id=scanner.id,
                is_enabled=is_enabled,
                risk_level_override=None,  # NULL means use package default
                scan_prompt_override=None,
                scan_response_override=None
            )
            db.add(config)

        db.flush()
        logger.info(f"  Initialized {len(scanners)} scanner configs")


def load_builtin_packages():
    """Main function to load all built-in packages"""
    logger.info("=" * 80)
    logger.info("Loading Built-in Scanner Packages")
    logger.info("=" * 80)

    # Package files directory
    builtin_dir = Path(__file__).parent.parent / 'builtin_scanners'

    if not builtin_dir.exists():
        logger.error(f"Built-in scanners directory not found: {builtin_dir}")
        return False

    # Get all JSON files
    package_files = list(builtin_dir.glob('*.json'))
    logger.info(f"Found {len(package_files)} package files")

    db = get_db_session()
    all_scanners = []

    try:
        for package_file in package_files:
            logger.info(f"\n--- Processing {package_file.name} ---")

            # Load package data
            package_data = load_package_from_file(package_file)

            # Create or update package
            package = create_or_update_package(db, package_data)

            # Create or update scanners
            scanners = create_or_update_scanners(
                db,
                package.id,
                package_data['scanners']
            )
            all_scanners.extend(scanners)

            logger.info(f"Package {package_data['package_code']} processed: {len(scanners)} scanners")

        # Initialize scanner configs for all applications
        logger.info("\n--- Initializing Scanner Configs for Applications ---")
        initialize_scanner_configs_for_applications(db, all_scanners)

        # Commit all changes
        db.commit()

        logger.info("\n" + "=" * 80)
        logger.info("✅ Successfully loaded all built-in scanner packages!")
        logger.info(f"   Total packages: {len(package_files)}")
        logger.info(f"   Total scanners: {len(all_scanners)}")
        logger.info("=" * 80)

        return True

    except Exception as e:
        logger.error(f"❌ Error loading built-in packages: {e}")
        db.rollback()
        import traceback
        traceback.print_exc()
        return False

    finally:
        db.close()


if __name__ == "__main__":
    success = load_builtin_packages()
    sys.exit(0 if success else 1)
