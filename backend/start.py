#!/usr/bin/env python3
"""
Unified entry point for the merged OpenGuardrails backend (Phase 3 step 6).

Replaces the three legacy launchers:
  - start_admin_service.py
  - start_detection_service.py
  - start_proxy_service.py

Configuration:
  UNIFIED_PORT             — port to listen on (default 5000, matches admin's
                             legacy port so an existing nginx config that
                             routes `/api/v1/*` to :5000 keeps working).
                             Detection/proxy traffic on the same port is
                             served by the merged app.
  UNIFIED_UVICORN_WORKERS  — worker count (default 8: 2× cores on a 4-core
                             box, the Phase 3 target). Down from the legacy
                             58 (admin 2 + detection 32 + proxy 24).

Migrations: same flow as start_admin_service.py — runs migrations once
before workers fork, using the Redis-backed (or PG-fallback) distributed
lock so multi-replica deploys are still safe.
"""

import os

import uvicorn

from config import settings
from utils.logger import setup_logger

logger = setup_logger()


def _run_migrations() -> None:
    """Run pending DB migrations before workers fork.

    Same pattern as the legacy admin entry point. Idempotent — the
    migration runner takes a distributed lock, so if multiple replicas
    start simultaneously only one runs migrations.
    """
    try:
        logger.info("=" * 60)
        logger.info("Running database migrations before service startup...")
        logger.info("=" * 60)

        from migrations.run_migrations import run_migrations

        executed, failed = run_migrations(dry_run=False)
        if failed > 0:
            logger.error("Database migrations failed! Service will not start.")
            raise Exception(f"Migration failed: {failed} migration(s) failed")
        if executed > 0:
            logger.info(f"Successfully executed {executed} pending migration(s)")
        else:
            logger.info("All migrations are up to date")
        logger.info("=" * 60)
    except Exception as e:
        logger.error(f"Migration check failed: {e}")
        logger.warning("Continuing service startup anyway (migration may have run elsewhere)...")


if __name__ == "__main__":
    _run_migrations()

    port = int(os.getenv("UNIFIED_PORT", "5000"))
    workers = int(os.getenv("UNIFIED_UVICORN_WORKERS", "8"))

    print(f"Starting {settings.app_name} unified service")
    print(f"  Port: {port}")
    print(f"  Workers: {workers if not settings.debug else 1}")
    print(f"  Surfaces: admin (/api/v1) + detection (/v1/guardrails*) + proxy (/v1/*)")

    uvicorn.run(
        "app:app",
        host=settings.host,
        port=port,
        reload=settings.debug,
        log_level=settings.log_level.lower(),
        workers=workers if not settings.debug else 1,
    )
