#!/usr/bin/env python3
"""
Load built-in scanner packages from backend/builtin_scanners into the database.

This script now reuses the shared loader module so it stays in sync with the
automatic initialization path that runs during service startup.
"""
import sys
from pathlib import Path

# Ensure backend is on sys.path when executing directly
sys.path.insert(0, str(Path(__file__).parent.parent))

from database.connection import get_admin_db_session  # noqa: E402
from services.builtin_scanner_loader import load_builtin_scanner_packages  # noqa: E402
from utils.logger import setup_logger  # noqa: E402

logger = setup_logger()


def load_builtin_packages() -> bool:
    """Load or update all built-in scanner packages for the configured language."""
    from config import settings

    logger.info("=" * 80)
    logger.info("Loading Built-in Scanner Packages")
    logger.info("Language: %s", settings.default_language)
    logger.info("=" * 80)

    db = get_admin_db_session()
    try:
        summary = load_builtin_scanner_packages(db, language=settings.default_language)
        logger.info("\n" + "=" * 80)
        logger.info("✅ Successfully loaded all built-in scanner packages!")
        logger.info("   Language: %s", settings.default_language)
        logger.info("   Total packages: %d", summary["packages"])
        logger.info("   Total scanners: %d", summary["scanners"])
        logger.info("=" * 80)
        return True
    except Exception as exc:  # pragma: no cover - CLI error path
        logger.error("❌ Error loading built-in packages: %s", exc)
        db.rollback()
        import traceback

        traceback.print_exc()
        return False
    finally:
        db.close()


if __name__ == "__main__":
    success = load_builtin_packages()
    sys.exit(0 if success else 1)
