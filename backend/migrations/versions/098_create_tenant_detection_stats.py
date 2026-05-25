"""Migration 097: tenant_detection_stats rollup (Step 7.4).

Creates the daily rollup table from `Base.metadata.create_all()` (so PG
and MySQL get identical DDL) and backfills it from the existing
`detection_results` rows. log_to_db_service then maintains it
incrementally.

Idempotent: re-running calls `backfill_stats` which TRUNCATEs and
recomputes — same end state. Backfill is bounded by detection_results
size; on the test DB (~3700 rows) it's milliseconds. For production
deployments with 200k+ rows expect seconds, still fine for a one-time
migration during deploy.
"""

from __future__ import annotations

from sqlalchemy import inspect


def upgrade(conn) -> None:
    from database.models import Base, TenantDetectionStats

    inspector = inspect(conn)
    if "tenant_detection_stats" not in inspector.get_table_names():
        TenantDetectionStats.__table__.create(bind=conn)

    # Backfill — uses a SQLAlchemy session bound to this connection so it
    # participates in the runner's transaction. The runner commits on
    # success.
    from sqlalchemy.orm import Session
    from services.detection_stats_service import backfill_stats

    session = Session(bind=conn)
    try:
        stats = backfill_stats(session)
        # The runner's logger is set up; use it via the standard logging path
        import logging
        logging.getLogger(__name__).info(
            "Migration 097 backfill: scanned=%d, rollup_rows=%d",
            stats["rows_scanned"], stats["rollup_rows"],
        )
    finally:
        session.close()
