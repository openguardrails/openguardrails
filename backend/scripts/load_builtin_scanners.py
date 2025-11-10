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
    Application, Tenant
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
    """Initialize scanner configs for all existing applications"""
    # Get all applications
    applications = db.query(Application).filter(Application.is_active == True).all()

    logger.info(f"Found {len(applications)} active applications")

    for app in applications:
        logger.info(f"Initializing scanner configs for application: {app.name} (ID: {app.id})")

        for scanner in scanners:
            # Check if config already exists
            existing_config = db.query(ApplicationScannerConfig).filter(
                ApplicationScannerConfig.application_id == app.id,
                ApplicationScannerConfig.scanner_id == scanner.id
            ).first()

            if existing_config:
                logger.debug(f"  Config already exists for scanner {scanner.tag}")
                continue

            # Create new config with default settings (enabled, no overrides)
            config = ApplicationScannerConfig(
                application_id=app.id,
                scanner_id=scanner.id,
                is_enabled=True,
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
