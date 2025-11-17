"""
Utilities for loading built-in scanner packages into the database.

These helpers are shared between the CLI script and the automatic
initialization path so that official scanners are always available.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from database.models import (
    Application,
    ApplicationScannerConfig,
    RiskTypeConfig,
    Scanner,
    ScannerPackage,
)
from utils.logger import setup_logger

logger = setup_logger()


def _load_package_from_file(file_path: Path) -> dict:
    """Load package metadata from JSON."""
    with open(file_path, "r", encoding="utf-8") as file:
        return json.load(file)


def _create_or_update_package(db: Session, package_data: dict) -> ScannerPackage:
    """Create or update a scanner package definition."""
    package_code = package_data["package_code"]

    package = (
        db.query(ScannerPackage)
        .filter(ScannerPackage.package_code == package_code)
        .first()
    )

    if package:
        logger.info("Updating built-in package %s", package_code)
        package.package_name = package_data["package_name"]
        package.author = package_data["author"]
        package.description = package_data["description"]
        package.version = package_data["version"]
        package.license = package_data.get("license", "Apache-2.0")
        package.package_type = "builtin"
        package.is_active = True
    else:
        logger.info("Creating built-in package %s", package_code)
        package = ScannerPackage(
            package_code=package_code,
            package_name=package_data["package_name"],
            author=package_data["author"],
            description=package_data["description"],
            version=package_data["version"],
            license=package_data.get("license", "Apache-2.0"),
            package_type="builtin",
            is_active=True,
        )
        db.add(package)

    db.flush()
    return package


def _create_or_update_scanners(
    db: Session, package_id, scanners_data: List[dict]
) -> List[Scanner]:
    """Create or update all scanners for a package."""
    updated: List[Scanner] = []

    for scanner_data in scanners_data:
        tag = scanner_data["tag"]
        scanner = (
            db.query(Scanner)
            .filter(Scanner.tag == tag, Scanner.package_id == package_id)
            .first()
        )

        if scanner:
            logger.info("Updating scanner %s", tag)
            scanner.scanner_type = scanner_data["type"]
            scanner.name = scanner_data["name"]
            scanner.definition = scanner_data["definition"]
            scanner.default_risk_level = scanner_data["risk_level"]
            scanner.default_scan_prompt = scanner_data.get("scan_prompt", True)
            scanner.default_scan_response = scanner_data.get("scan_response", False)
            scanner.is_active = True
        else:
            logger.info("Creating scanner %s", tag)
            scanner = Scanner(
                package_id=package_id,
                tag=tag,
                scanner_type=scanner_data["type"],
                name=scanner_data["name"],
                definition=scanner_data["definition"],
                default_risk_level=scanner_data["risk_level"],
                default_scan_prompt=scanner_data.get("scan_prompt", True),
                default_scan_response=scanner_data.get("scan_response", False),
                is_active=True,
            )
            db.add(scanner)

        db.flush()
        updated.append(scanner)

    return updated


def _initialize_scanner_configs_for_applications(
    db: Session, scanners: List[Scanner]
) -> None:
    """Ensure all applications have config rows for the provided scanners."""
    applications = db.query(Application).filter(Application.is_active == True).all()  # noqa: E712
    logger.info("Initializing scanner configs for %d applications", len(applications))

    for app in applications:
        logger.info("Ensuring configs for application %s", app.name)
        risk_config = (
            db.query(RiskTypeConfig).filter(RiskTypeConfig.application_id == app.id).first()
        )

        enabled_map = {}
        if risk_config:
            enabled_map = {
                "S1": getattr(risk_config, "s1_enabled", True),
                "S2": getattr(risk_config, "s2_enabled", True),
                "S3": getattr(risk_config, "s3_enabled", True),
                "S4": getattr(risk_config, "s4_enabled", True),
                "S5": getattr(risk_config, "s5_enabled", True),
                "S6": getattr(risk_config, "s6_enabled", True),
                "S7": getattr(risk_config, "s7_enabled", True),
                "S8": getattr(risk_config, "s8_enabled", True),
                "S9": getattr(risk_config, "s9_enabled", True),
                "S10": getattr(risk_config, "s10_enabled", True),
                "S11": getattr(risk_config, "s11_enabled", True),
                "S12": getattr(risk_config, "s12_enabled", True),
                "S13": getattr(risk_config, "s13_enabled", True),
                "S14": getattr(risk_config, "s14_enabled", True),
                "S15": getattr(risk_config, "s15_enabled", True),
                "S16": getattr(risk_config, "s16_enabled", True),
                "S17": getattr(risk_config, "s17_enabled", True),
                "S18": getattr(risk_config, "s18_enabled", True),
                "S19": getattr(risk_config, "s19_enabled", True),
                "S20": getattr(risk_config, "s20_enabled", True),
                "S21": getattr(risk_config, "s21_enabled", True),
            }

        for scanner in scanners:
            existing_config = (
                db.query(ApplicationScannerConfig)
                .filter(
                    ApplicationScannerConfig.application_id == app.id,
                    ApplicationScannerConfig.scanner_id == scanner.id,
                )
                .first()
            )

            if existing_config:
                continue

            is_enabled = enabled_map.get(scanner.tag, True) if enabled_map else True
            db.add(
                ApplicationScannerConfig(
                    application_id=app.id,
                    scanner_id=scanner.id,
                    is_enabled=is_enabled,
                    risk_level_override=None,
                    scan_prompt_override=None,
                    scan_response_override=None,
                )
            )

        db.flush()


def load_builtin_scanner_packages(
    db: Session,
    builtin_dir: Optional[Path] = None,
    initialize_configs: bool = True,
    auto_commit: bool = True,
) -> Dict[str, int]:
    """
    Load all built-in scanner packages from disk.

    Returns a summary dict with package and scanner counts.
    """
    directory = (
        builtin_dir
        if builtin_dir
        else Path(__file__).resolve().parent.parent / "builtin_scanners"
    )

    if not directory.exists():
        raise FileNotFoundError(f"Built-in scanners directory not found: {directory}")

    package_files = sorted(directory.glob("*.json"))
    logger.info("Found %d built-in package file(s)", len(package_files))

    all_scanners: List[Scanner] = []
    for package_file in package_files:
        logger.info("Processing built-in package file %s", package_file.name)
        package_data = _load_package_from_file(package_file)
        package = _create_or_update_package(db, package_data)
        scanners = _create_or_update_scanners(db, package.id, package_data["scanners"])
        all_scanners.extend(scanners)
        logger.info(
            "Package %s processed (%d scanner(s))",
            package_data["package_code"],
            len(scanners),
        )

    if initialize_configs and all_scanners:
        _initialize_scanner_configs_for_applications(db, all_scanners)

    if auto_commit:
        db.commit()

    summary = {"packages": len(package_files), "scanners": len(all_scanners)}
    logger.info(
        "Built-in scanners loaded (packages=%d, scanners=%d)",
        summary["packages"],
        summary["scanners"],
    )
    return summary
