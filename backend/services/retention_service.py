"""Detection-data retention service (Step 7.3).

Two global super-admin settings stored in `system_config`:
  - `payload_retention_days` (default 30) — how long the heavy detection
    payload fields (full_messages, messages, model_response, image_paths,
    unsafe_segments, content/original_content) are kept. Rows older than
    this have those fields nulled out; metadata stays.
  - `metadata_retention_days` (default 0 = never) — how long the metadata
    row itself lives. 0 means metadata is kept forever; positive N means
    rows older than N days get fully deleted (including the already-
    nulled payload).

Production path: a daily background job calls `purge_old_detection_data`.
Stats are returned for observability. Idempotent — running twice in a
row clears nothing the second time.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from database.models import SystemConfig

logger = logging.getLogger(__name__)

# Config keys. The values are stored as text in `config_value`.
KEY_PAYLOAD_RETENTION = "payload_retention_days"
KEY_METADATA_RETENTION = "metadata_retention_days"

# Defaults. Used when the config row is absent.
DEFAULT_PAYLOAD_RETENTION_DAYS = 30
DEFAULT_METADATA_RETENTION_DAYS = 0  # 0 = keep forever

# Heavy fields that get nulled when payload retention expires. Order matters
# for the UPDATE statement only insofar as we want it deterministic — these
# are the columns the user-visible "view detection detail" page shows.
PAYLOAD_FIELDS = (
    "content",
    "original_content",
    "model_response",
    "full_messages",
    "messages",
    "image_paths",
    "unsafe_segments",
    "doublecheck_categories",
    "doublecheck_reasoning",
    "matched_window_indices",
)


def _get_int_config(db: Session, key: str, default: int) -> int:
    """Read an integer value out of system_config. Returns default if the
    row is missing or the value can't be parsed.
    """
    row = db.query(SystemConfig).filter(SystemConfig.config_key == key).one_or_none()
    if row is None or row.config_value is None:
        return default
    try:
        return int(row.config_value)
    except (TypeError, ValueError):
        logger.warning(
            "system_config[%s] = %r is not a valid integer; using default %d",
            key, row.config_value, default,
        )
        return default


def _set_int_config(db: Session, key: str, value: int, description: str) -> None:
    """Upsert an integer config value. Caller commits."""
    if value < 0:
        raise ValueError(f"{key} must be >= 0 (got {value})")
    row = db.query(SystemConfig).filter(SystemConfig.config_key == key).one_or_none()
    if row is None:
        row = SystemConfig(config_key=key, config_value=str(value), description=description)
        db.add(row)
    else:
        row.config_value = str(value)
        if not row.description:
            row.description = description


def get_payload_retention_days(db: Session) -> int:
    """Days to keep detection payload fields. Default 30."""
    return _get_int_config(db, KEY_PAYLOAD_RETENTION, DEFAULT_PAYLOAD_RETENTION_DAYS)


def get_metadata_retention_days(db: Session) -> int:
    """Days to keep detection metadata rows. Default 0 = forever."""
    return _get_int_config(db, KEY_METADATA_RETENTION, DEFAULT_METADATA_RETENTION_DAYS)


def set_payload_retention_days(db: Session, days: int) -> None:
    _set_int_config(
        db, KEY_PAYLOAD_RETENTION, days,
        "Days to keep detection payload (content / messages / model_response). 0 = never purge.",
    )


def set_metadata_retention_days(db: Session, days: int) -> None:
    _set_int_config(
        db, KEY_METADATA_RETENTION, days,
        "Days to keep detection metadata rows. 0 = keep forever.",
    )


def purge_old_detection_data(db: Session) -> dict:
    """Apply both retention windows. Caller owns the transaction.

    Returns counts so the caller (cron + observability) can log progress:
        {"payload_cleared": int, "payload_rows_deleted": int,
         "rows_deleted": int,
         "payload_retention_days": int, "metadata_retention_days": int}

    Step 7.2: this also deletes from `detection_result_payloads` (the
    sibling table written by log_to_db_service since 099). The legacy
    in-place null-out on `detection_results` stays in place too —
    until readers migrate to the sibling, both stores must converge.
    """
    payload_days = get_payload_retention_days(db)
    metadata_days = get_metadata_retention_days(db)

    now = datetime.now(timezone.utc)
    payload_cutoff = now - timedelta(days=payload_days) if payload_days > 0 else None
    metadata_cutoff = now - timedelta(days=metadata_days) if metadata_days > 0 else None

    payload_cleared = 0
    payload_rows_deleted = 0
    rows_deleted = 0

    # Order matters: delete metadata-expired rows first (they're already
    # past payload expiry too), then null out payloads on the rest. Reduces
    # the number of rows the second statement touches. CASCADE on the
    # payload sibling drops its rows automatically.
    if metadata_cutoff is not None:
        result = db.execute(
            text("DELETE FROM detection_results WHERE created_at < :cutoff"),
            {"cutoff": metadata_cutoff},
        )
        rows_deleted = result.rowcount or 0

    if payload_cutoff is not None:
        # New path: drop the entire payload sibling row for any
        # detection_result older than the payload cutoff. Cheap, clean,
        # readers can switch to LEFT JOIN later.
        result = db.execute(
            text(
                """
                DELETE FROM detection_result_payloads
                WHERE detection_result_id IN (
                    SELECT id FROM detection_results WHERE created_at < :cutoff
                )
                """
            ),
            {"cutoff": payload_cutoff},
        )
        payload_rows_deleted = result.rowcount or 0

        # Legacy path: null the heavy fields on detection_results for
        # readers that haven't migrated to the sibling. `content` is
        # NOT NULL so use empty string. Skip already-cleared rows for
        # idempotency.
        set_clauses = ", ".join(f"{f} = NULL" for f in PAYLOAD_FIELDS)
        set_clauses = set_clauses.replace("content = NULL", "content = ''")
        result = db.execute(
            text(
                f"UPDATE detection_results SET {set_clauses} "
                f"WHERE created_at < :cutoff AND content <> ''"
            ),
            {"cutoff": payload_cutoff},
        )
        payload_cleared = result.rowcount or 0

    db.commit()

    return {
        "payload_cleared": payload_cleared,
        "payload_rows_deleted": payload_rows_deleted,
        "rows_deleted": rows_deleted,
        "payload_retention_days": payload_days,
        "metadata_retention_days": metadata_days,
    }
