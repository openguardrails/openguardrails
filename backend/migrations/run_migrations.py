#!/usr/bin/env python3
"""
Database Migration Runner
Automatically runs pending SQL migrations in order
"""

import os
import sys
import importlib.util
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


def _dialect_name() -> str:
    """Return the engine's dialect name ('postgresql', 'mysql', 'mariadb', ...).

    Phase 4a: the runner used to be hardcoded for PostgreSQL (TIMESTAMP
    WITH TIME ZONE, ON CONFLICT, CREATE INDEX IF NOT EXISTS). Branching
    on this lets MySQL deploys run their first migration. SQLAlchemy
    normalizes the name so we can match exact strings. MariaDB reports
    as 'mariadb' and is treated like MySQL — the upsert and DDL we use
    are MySQL-5.7-compatible, which MariaDB 10.x accepts.
    """
    return admin_engine.dialect.name


def _is_mysql_family(name: str) -> bool:
    return name in ("mysql", "mariadb")


def get_migration_files() -> List[Tuple[int, str, Path]]:
    """
    Get all migration files sorted by version number

    Returns:
        List of tuples: (version_number, description, file_path)

    Picks up both `.sql` (raw DDL) and `.py` (Python module exporting an
    `upgrade(conn)` callable). Python migrations were added in Phase 4a so
    `000_initial_schema.py` can call `Base.metadata.create_all()` for
    portable PG/MySQL bootstrap. `.py` and `.sql` share the same version
    namespace; the runner picks them up in numeric order regardless of
    extension.
    """
    migrations = []
    seen_versions = {}

    if not MIGRATIONS_DIR.exists():
        logger.warning(f"Migrations directory not found: {MIGRATIONS_DIR}")
        return migrations

    for ext in ("sql", "py"):
        for file_path in MIGRATIONS_DIR.glob(f"*.{ext}"):
            filename = file_path.name
            if filename == "__init__.py":
                continue

            # Parse filename: 001_description.{sql,py}
            try:
                parts = filename.rsplit(".", 1)[0].split("_", 1)
                version = int(parts[0])
                description = parts[1] if len(parts) > 1 else "unnamed"
            except (ValueError, IndexError) as e:
                logger.warning(f"Skipping invalid migration filename: {filename} ({e})")
                continue

            if version in seen_versions:
                logger.warning(
                    f"Duplicate migration version {version}: "
                    f"{seen_versions[version].name} and {filename} — using the first."
                )
                continue
            seen_versions[version] = file_path
            migrations.append((version, description, file_path))

    # Sort by version number
    migrations.sort(key=lambda x: x[0])
    return migrations


def create_migration_table(conn):
    """Create the schema_migrations table if it doesn't exist.

    Dialect notes:
      - PostgreSQL: TIMESTAMP WITH TIME ZONE; CREATE INDEX IF NOT EXISTS works.
      - MySQL/MariaDB: plain TIMESTAMP (no timezone-aware variant);
        CREATE INDEX has no IF NOT EXISTS, so we probe
        information_schema.statistics first and skip the create if the
        index is already present.

    The table itself is identical across dialects apart from the
    timestamp type, so we only branch the type expression and the index
    creation.
    """
    dialect = _dialect_name()

    timestamp_type = (
        "TIMESTAMP DEFAULT CURRENT_TIMESTAMP"
        if _is_mysql_family(dialect)
        else "TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP"
    )

    create_table_sql = f"""
    CREATE TABLE IF NOT EXISTS {MIGRATION_TABLE} (
        version INTEGER PRIMARY KEY,
        description VARCHAR(255) NOT NULL,
        filename VARCHAR(255) NOT NULL,
        executed_at {timestamp_type},
        success BOOLEAN DEFAULT true,
        error_message TEXT
    )
    """

    conn.execute(text(create_table_sql))

    index_name = "idx_schema_migrations_executed_at"
    if _is_mysql_family(dialect):
        # MySQL has no CREATE INDEX IF NOT EXISTS — probe first.
        existing = conn.execute(
            text(
                "SELECT 1 FROM information_schema.statistics "
                "WHERE table_schema = DATABASE() "
                "  AND table_name = :table_name "
                "  AND index_name = :index_name "
                "LIMIT 1"
            ),
            {"table_name": MIGRATION_TABLE, "index_name": index_name},
        ).first()
        if not existing:
            conn.execute(
                text(f"CREATE INDEX {index_name} ON {MIGRATION_TABLE}(executed_at)")
            )
    else:
        conn.execute(
            text(
                f"CREATE INDEX IF NOT EXISTS {index_name} "
                f"ON {MIGRATION_TABLE}(executed_at)"
            )
        )

    conn.commit()
    logger.info(
        f"Migration tracking table '{MIGRATION_TABLE}' ready (dialect={dialect})"
    )


def get_executed_migrations(conn) -> set:
    """Get set of already executed migration versions"""
    result = conn.execute(
        text(f"SELECT version FROM {MIGRATION_TABLE} WHERE success = true")
    )
    return {row[0] for row in result}


def _record_migration_sql(success: bool) -> str:
    """Return a dialect-appropriate UPSERT for the schema_migrations row.

    Both branches set the same columns. The difference is just the
    conflict-handling syntax:
      - PostgreSQL: ON CONFLICT (version) DO UPDATE SET col = EXCLUDED.col
      - MySQL / MariaDB: ON DUPLICATE KEY UPDATE col = VALUES(col)
        VALUES() is the legacy form (deprecated in 8.0.20 but still
        works); the modern AS new form would limit us to MySQL 8.0.20+
        unnecessarily. The PRIMARY KEY on `version` is what makes
        ON DUPLICATE KEY trigger.

    `success` and `error_message` are written as fixed expressions
    (true / NULL on the success path; false / new error on the failure
    path) rather than referenced via EXCLUDED/VALUES, which works
    identically on both dialects and makes the intent obvious.
    """
    dialect = _dialect_name()

    if success:
        common_columns = "(version, description, filename, success)"
        common_values = "(:version, :description, :filename, true)"
    else:
        common_columns = "(version, description, filename, success, error_message)"
        common_values = "(:version, :description, :filename, false, :error)"

    insert_clause = (
        f"INSERT INTO {MIGRATION_TABLE} {common_columns} VALUES {common_values}"
    )

    if _is_mysql_family(dialect):
        if success:
            update_clause = (
                "ON DUPLICATE KEY UPDATE "
                "description = VALUES(description), "
                "filename = VALUES(filename), "
                "executed_at = CURRENT_TIMESTAMP, "
                "success = true, "
                "error_message = NULL"
            )
        else:
            update_clause = (
                "ON DUPLICATE KEY UPDATE "
                "description = VALUES(description), "
                "filename = VALUES(filename), "
                "executed_at = CURRENT_TIMESTAMP, "
                "success = false, "
                "error_message = VALUES(error_message)"
            )
    else:
        if success:
            update_clause = (
                "ON CONFLICT (version) DO UPDATE SET "
                "description = EXCLUDED.description, "
                "filename = EXCLUDED.filename, "
                "executed_at = CURRENT_TIMESTAMP, "
                "success = true, "
                "error_message = NULL"
            )
        else:
            update_clause = (
                "ON CONFLICT (version) DO UPDATE SET "
                "description = EXCLUDED.description, "
                "filename = EXCLUDED.filename, "
                "executed_at = CURRENT_TIMESTAMP, "
                "success = false, "
                "error_message = EXCLUDED.error_message"
            )

    return f"{insert_clause} {update_clause}"


def _execute_python_migration(conn, file_path: Path) -> None:
    """Import a `.py` migration and invoke its `upgrade(conn)` function.

    Phase 4a: lets `000_initial_schema.py` call
    `Base.metadata.create_all()` for portable PG/MySQL bootstrap.
    Connection is passed in already inside the runner's transaction —
    the migration callable should perform DDL via `conn.execute(text(...))`
    or via SQLAlchemy schema objects bound to `conn.engine`. The runner
    handles commit/rollback and the schema_migrations row.
    """
    spec = importlib.util.spec_from_file_location(f"migration_{file_path.stem}", file_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load migration module: {file_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    upgrade = getattr(module, "upgrade", None)
    if not callable(upgrade):
        raise RuntimeError(
            f"Migration {file_path.name}: missing or non-callable `upgrade(conn)`"
        )
    upgrade(conn)


def execute_migration(conn, version: int, description: str, file_path: Path) -> bool:
    """
    Execute a single migration file

    Returns:
        True if successful, False otherwise
    """
    logger.info(f"Executing migration {version}: {description}")

    try:
        if file_path.suffix == ".py":
            _execute_python_migration(conn, file_path)
        else:
            # Read SQL file
            with open(file_path, 'r', encoding='utf-8') as f:
                sql_content = f.read()

            # Execute SQL (may contain multiple statements)
            conn.execute(text(sql_content))

        # Record successful execution. Idempotent upsert — same migration
        # version may be re-recorded if a previous failed run wrote a
        # row. Dialect-aware via _record_migration_sql().
        conn.execute(
            text(_record_migration_sql(success=True)),
            {
                "version": version,
                "description": description,
                "filename": file_path.name,
            },
        )

        conn.commit()
        logger.info(f"✓ Migration {version} completed successfully")
        return True

    except Exception as e:
        conn.rollback()
        error_msg = str(e)
        logger.error(f"✗ Migration {version} failed: {error_msg}")

        # Record failed execution (idempotent upsert).
        try:
            conn.execute(
                text(_record_migration_sql(success=False)),
                {
                    "version": version,
                    "description": description,
                    "filename": file_path.name,
                    "error": error_msg[:1000],  # Limit error message length
                },
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

    # Distributed lock to prevent concurrent migration execution across
    # workers. Uses Redis when REDIS_URL is set; falls back to PG advisory
    # lock for the legacy PG-only deployments. The 64-bit PG key is
    # preserved so a deployment in the middle of a rolling restart sees
    # consistent semantics across old and new processes.
    from services.distributed_lock import acquire_sync, release_sync
    from services.redis_client import is_redis_enabled
    migration_pg_lock_key = 0x4D49_4752_4154_494F  # "MIGRATIO" in hex

    # PG advisory locks only work on PG. For MySQL deploys without
    # Redis, fall through with no distributed lock — the migration
    # runner is invoked once per container at startup and on a fresh
    # MySQL deploy there is no concurrent runner to coordinate with.
    # When Redis is available, acquire_sync uses it regardless of
    # dialect.
    use_pg_fallback = _dialect_name() == "postgresql"
    handle = acquire_sync(
        name="db_migrations",
        ttl_seconds=1800,  # 30 min — generous bound for slow migrations on large tables
        pg_fallback_engine=admin_engine if use_pg_fallback else None,
        pg_fallback_lock_key=migration_pg_lock_key if use_pg_fallback else None,
    )

    if handle is None and is_redis_enabled():
        # Lock-failure path only meaningful when a real lock backend
        # was available. If Redis is enabled and acquire returned None,
        # someone else owns the lock — back off.
        logger.info("Another process is running migrations, skipping...")
        return 0, 0

    try:
        executed, failed = _run_migrations_internal(migrations, dry_run)
        return executed, failed
    finally:
        if handle is not None:
            release_sync(handle)


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
        skipped_count = 0

        for version, description, file_path in pending:
            # Re-check `schema_migrations` per iteration: a previous migration
            # may have stamped this one as already-applied (e.g.
            # `000_initial_schema.py` bootstraps the schema and stamps every
            # subsequent SQL migration in one go). Without this re-check the
            # runner would still try to execute the stamped migrations because
            # `pending` was a snapshot taken before the loop started.
            current_executed = get_executed_migrations(conn)
            if version in current_executed:
                logger.info(
                    f"Skipping migration {version} ({description}) — "
                    f"already stamped by a prior migration."
                )
                skipped_count += 1
                continue

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
        logger.info(f"  Skipped (pre-stamped): {skipped_count}")
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
