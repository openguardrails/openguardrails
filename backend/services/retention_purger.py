"""Daily background purge of detection data per global retention policy.

Pattern matches `services/cache_cleaner.py`: started/stopped from the app
lifespan, runs in a single background asyncio task, sleeps until the next
firing window.

Why daily and not hourly: deletes are bulk operations and we don't want
to interleave them with bursty detection writes. One pass per day is
plenty given retention windows are measured in days.

Resilience: every iteration is wrapped in try/except so a transient DB
error doesn't kill the loop. The next iteration just retries on the next
window.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from database.connection import get_admin_db_session
from services.retention_service import purge_old_detection_data
from utils.logger import setup_logger

logger = setup_logger()

# Run once a day. The wakeup is timed off the loop's monotonic clock so
# clock skew doesn't cause double-runs around DST transitions.
PURGE_INTERVAL_SECONDS = 24 * 60 * 60

# When the service first starts, wait this long before the first run so a
# rolling restart doesn't slam the DB with multiple replicas all purging
# at once. 5 min is enough that staggered restarts settle, and short
# enough that operators see the first run within a normal observation
# window.
INITIAL_DELAY_SECONDS = 5 * 60


class RetentionPurger:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._running = False

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop())
        logger.info("Retention purger started (interval=%ds)", PURGE_INTERVAL_SECONDS)

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        logger.info("Retention purger stopped")

    async def _loop(self) -> None:
        # Stagger first run.
        try:
            await asyncio.sleep(INITIAL_DELAY_SECONDS)
        except asyncio.CancelledError:
            return

        while self._running:
            try:
                self._run_once()
            except asyncio.CancelledError:
                return
            except Exception as e:  # pragma: no cover — defensive
                logger.exception("Retention purge iteration failed: %s", e)

            try:
                await asyncio.sleep(PURGE_INTERVAL_SECONDS)
            except asyncio.CancelledError:
                return

    def _run_once(self) -> None:
        """One purge pass. Synchronous DB session — `get_admin_db_session`
        returns a sync `Session`, which is fine for a daily housekeeping
        task running off a dedicated background asyncio task. The blocking
        DB call doesn't matter here because nothing else shares this task.
        """
        started = datetime.now(timezone.utc)
        db = get_admin_db_session()
        try:
            stats = purge_old_detection_data(db)
        finally:
            db.close()
        elapsed = (datetime.now(timezone.utc) - started).total_seconds()
        logger.info(
            "Retention purge finished in %.1fs: payload_cleared=%d, "
            "payload_rows_deleted=%d, rows_deleted=%d, "
            "payload_retention_days=%d, metadata_retention_days=%d",
            elapsed,
            stats["payload_cleared"],
            stats.get("payload_rows_deleted", 0),
            stats["rows_deleted"],
            stats["payload_retention_days"],
            stats["metadata_retention_days"],
        )


retention_purger = RetentionPurger()
