"""Migration 000: Initial schema bootstrap (Phase 4a, dialect-aware).

When a fresh database has no application tables, this migration calls
`Base.metadata.create_all()` to materialize the entire schema declared
in `database/models.py`, then stamps every later `*.sql` migration as
already applied — they encode the historical DDL deltas that produced
the current `models.py` shape, and replaying them on top of a freshly
created schema would either no-op or conflict.

When the database already contains application tables (the common case
for existing PG production deploys, where migrations 001..094 ran
incrementally over time), this migration is a no-op: the runner
records it as applied, the schema is left untouched, and subsequent
migrations continue normally.

Bootstrap path also emits PG-only post-creation extras:
  - `pg_trgm` extension + GIN index on `detection_results.content` /
    `request_id`. These cannot be expressed in dialect-agnostic
    SQLAlchemy (Step 5 design call still pending — MySQL deploys get
    plain LIKE for now).

Detection sentinel: presence of `tenants` table. It is the root of
every other relation; if it exists, *something* has bootstrapped the
schema before us.
"""

from __future__ import annotations

import sys
from pathlib import Path

from sqlalchemy import inspect, text

# `database` and other repo modules sit two levels up from this file
# (backend/migrations/versions/000_initial_schema.py → backend/).
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from database.connection import Base, admin_engine  # noqa: E402
import database.models  # noqa: F401, E402  # registers all 48 tables on Base.metadata


SENTINEL_TABLE = "tenants"
THIS_VERSION = 0


def _is_postgresql(conn) -> bool:
    return conn.dialect.name == "postgresql"


def _stamp_existing_sql_migrations(conn) -> int:
    """Mark every `.sql` migration newer than 000 as already applied.

    Reuses the runner's dialect-aware UPSERT helper so we don't duplicate
    that branching here.
    """
    from migrations.run_migrations import (
        MIGRATIONS_DIR,
        _record_migration_sql,
    )

    stamped = 0
    for file_path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        filename = file_path.name
        try:
            parts = filename.rsplit(".", 1)[0].split("_", 1)
            version = int(parts[0])
            description = parts[1] if len(parts) > 1 else "unnamed"
        except (ValueError, IndexError):
            continue

        if version <= THIS_VERSION:
            continue

        conn.execute(
            text(_record_migration_sql(success=True)),
            {
                "version": version,
                "description": description,
                "filename": filename,
            },
        )
        stamped += 1

    return stamped


def _emit_postgres_post_create_ddl(conn) -> None:
    """Phase-4a placeholder for the pg_trgm GIN index.

    Migration 093 emits these incrementally on existing PG deploys; on
    fresh PG bootstraps via this 000 migration, 093 is stamped (not
    executed), so we replay the trgm DDL here. Step 5 will revisit
    whether to keep it PG-only or build a portable equivalent.
    """
    conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_trgm"))
    conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS idx_detection_results_content_trgm "
            "ON detection_results USING gin (content gin_trgm_ops)"
        )
    )
    conn.execute(
        text(
            "CREATE INDEX IF NOT EXISTS idx_detection_results_request_id_trgm "
            "ON detection_results USING gin (request_id gin_trgm_ops)"
        )
    )


def upgrade(conn) -> None:
    """Bootstrap on fresh DB; no-op on populated DB."""
    inspector = inspect(conn)
    if SENTINEL_TABLE in inspector.get_table_names():
        # Existing deploy — schema already materialized by some prior path
        # (incremental SQL migrations on PG, or a previous 000 run).
        return

    # Fresh DB — materialize the full schema from models.py.
    # `create_all` reads from Base.metadata; we use the runner's
    # connection (and hence transaction) so all DDL is one atomic unit.
    Base.metadata.create_all(bind=conn)

    if _is_postgresql(conn):
        _emit_postgres_post_create_ddl(conn)

    stamped = _stamp_existing_sql_migrations(conn)

    # Re-import logger lazily — module import path differs depending on
    # how the runner loads us (importlib.spec vs. direct python -m).
    try:
        from utils.logger import setup_logger
        setup_logger().info(
            f"Bootstrap complete: schema created from models.py, "
            f"{stamped} subsequent SQL migrations stamped as applied."
        )
    except Exception:  # pragma: no cover — logger is non-essential here
        pass
