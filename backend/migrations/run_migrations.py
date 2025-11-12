#!/usr/bin/env python3
"""
Database Migration Runner
Automatically runs pending SQL migrations in order
"""

import os
import sys
from pathlib import Path
from typing import List, Tuple
import asyncio
from sqlalchemy import text

# Add parent directory to path to import config
sys.path.insert(0, str(Path(__file__).parent.parent))

from config import settings
from database.connection import admin_engine
from utils.logger import setup_logger

logger = setup_logger()

MIGRATIONS_DIR = Path(__file__).parent / "versions"
MIGRATION_TABLE = "schema_migrations"


def get_migration_files() -> List[Tuple[int, str, Path]]:
    """
    Get all migration files sorted by version number

    Returns:
        List of tuples: (version_number, description, file_path)
    """
    migrations = []

    if not MIGRATIONS_DIR.exists():
        logger.warning(f"Migrations directory not found: {MIGRATIONS_DIR}")
        return migrations

    for file_path in MIGRATIONS_DIR.glob("*.sql"):
        filename = file_path.name

        # Parse filename: 001_description.sql
        try:
            parts = filename.replace(".sql", "").split("_", 1)
            version = int(parts[0])
            description = parts[1] if len(parts) > 1 else "unnamed"
            migrations.append((version, description, file_path))
        except (ValueError, IndexError) as e:
            logger.warning(f"Skipping invalid migration filename: {filename} ({e})")
            continue

    # Sort by version number
    migrations.sort(key=lambda x: x[0])
    return migrations


def create_migration_table(conn):
    """Create the schema_migrations table if it doesn't exist"""
    create_table_sql = f"""
    CREATE TABLE IF NOT EXISTS {MIGRATION_TABLE} (
        version INTEGER PRIMARY KEY,
        description VARCHAR(255) NOT NULL,
        filename VARCHAR(255) NOT NULL,
        executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        success BOOLEAN DEFAULT true,
        error_message TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_schema_migrations_executed_at
    ON {MIGRATION_TABLE}(executed_at);
    """

    conn.execute(text(create_table_sql))
    conn.commit()
    logger.info(f"Migration tracking table '{MIGRATION_TABLE}' ready")


def get_executed_migrations(conn) -> set:
    """Get set of already executed migration versions"""
    result = conn.execute(
        text(f"SELECT version FROM {MIGRATION_TABLE} WHERE success = true")
    )
    return {row[0] for row in result}


def execute_migration(conn, version: int, description: str, file_path: Path) -> bool:
    """
    Execute a single migration file

    Returns:
        True if successful, False otherwise
    """
    logger.info(f"Executing migration {version}: {description}")

    try:
        # Read SQL file
        with open(file_path, 'r', encoding='utf-8') as f:
            sql_content = f.read()

        # Execute SQL (may contain multiple statements)
        conn.execute(text(sql_content))

        # Record successful execution (use INSERT ON CONFLICT for idempotency)
        conn.execute(
            text(f"""
                INSERT INTO {MIGRATION_TABLE}
                (version, description, filename, success)
                VALUES (:version, :description, :filename, true)
                ON CONFLICT (version) DO UPDATE SET
                    description = EXCLUDED.description,
                    filename = EXCLUDED.filename,
                    executed_at = CURRENT_TIMESTAMP,
                    success = true,
                    error_message = NULL
            """),
            {
                "version": version,
                "description": description,
                "filename": file_path.name
            }
        )

        conn.commit()
        logger.info(f"✓ Migration {version} completed successfully")
        return True

    except Exception as e:
        conn.rollback()
        error_msg = str(e)
        logger.error(f"✗ Migration {version} failed: {error_msg}")

        # Record failed execution (use INSERT ON CONFLICT for idempotency)
        try:
            conn.execute(
                text(f"""
                    INSERT INTO {MIGRATION_TABLE}
                    (version, description, filename, success, error_message)
                    VALUES (:version, :description, :filename, false, :error)
                    ON CONFLICT (version) DO UPDATE SET
                        description = EXCLUDED.description,
                        filename = EXCLUDED.filename,
                        executed_at = CURRENT_TIMESTAMP,
                        success = false,
                        error_message = EXCLUDED.error_message
                """),
                {
                    "version": version,
                    "description": description,
                    "filename": file_path.name,
                    "error": error_msg[:1000]  # Limit error message length
                }
            )
            conn.commit()
        except Exception as record_error:
            logger.error(f"Failed to record migration failure: {record_error}")

        return False


def run_migrations(dry_run: bool = False) -> Tuple[int, int]:
    """
    Run all pending migrations

    Args:
        dry_run: If True, only show what would be executed

    Returns:
        Tuple of (executed_count, failed_count)
    """
    logger.info("=" * 60)
    logger.info("Database Migration Runner")
    logger.info("=" * 60)

    # Get all migration files
    migrations = get_migration_files()

    if not migrations:
        logger.info("No migration files found")
        return 0, 0

    logger.info(f"Found {len(migrations)} migration file(s)")

    # Use a migration-specific lock to prevent concurrent migration execution
    migration_lock_key = 0x4D49_4752_4154_494F  # "MIGRATIO" in hex

    # Connect to database with autocommit to manage locks
    with admin_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as lock_conn:
        # Try to acquire migration lock with a short timeout
        result = lock_conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": migration_lock_key})
        lock_acquired = result.scalar()

        if not lock_acquired:
            logger.info("Another process is running migrations, skipping...")
            return 0, 0

        try:
            # Now run migrations in a separate connection/transaction
            executed, failed = _run_migrations_internal(migrations, dry_run)
            return executed, failed
        finally:
            # Release migration lock
            lock_conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": migration_lock_key})


def _run_migrations_internal(migrations: List[Tuple[int, str, Path]], dry_run: bool) -> Tuple[int, int]:
    """Internal migration runner with separate connection"""
    # Connect to database
    with admin_engine.connect() as conn:
        # Create migration tracking table
        create_migration_table(conn)

        # Get already executed migrations
        executed = get_executed_migrations(conn)

        # Filter pending migrations
        pending = [m for m in migrations if m[0] not in executed]

        if not pending:
            logger.info("✓ All migrations are up to date")
            return 0, 0

        logger.info(f"Found {len(pending)} pending migration(s):")
        for version, description, file_path in pending:
            logger.info(f"  - {version:03d}: {description}")

        if dry_run:
            logger.info("\n[DRY RUN] No migrations were executed")
            return 0, 0

        logger.info("\nExecuting pending migrations...")

        executed_count = 0
        failed_count = 0

        for version, description, file_path in pending:
            success = execute_migration(conn, version, description, file_path)

            if success:
                executed_count += 1
            else:
                failed_count += 1
                logger.error(f"Migration {version} failed. Stopping migration process.")
                break

        logger.info("=" * 60)
        logger.info(f"Migration Summary:")
        logger.info(f"  Executed: {executed_count}")
        logger.info(f"  Failed: {failed_count}")
        logger.info("=" * 60)

        return executed_count, failed_count


def main():
    """Main entry point"""
    import argparse

    parser = argparse.ArgumentParser(description="Run database migrations")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show pending migrations without executing them"
    )

    args = parser.parse_args()

    try:
        executed, failed = run_migrations(dry_run=args.dry_run)

        if failed > 0:
            sys.exit(1)

        sys.exit(0)

    except Exception as e:
        logger.error(f"Migration runner failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
