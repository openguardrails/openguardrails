"""Detection stats rollup helpers (Step 7.4).

`TenantDetectionStats` is a per-(tenant, application, date) daily
counter. log_to_db_service calls `increment_for_detection` as it
inserts each row; dashboard endpoints query the rollup instead of
scanning `detection_results`. Backfill is idempotent.
"""

from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timezone
from typing import Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from database.models import DetectionResult, TenantDetectionStats

logger = logging.getLogger(__name__)

_SENTINEL_APPLICATION_KEY = uuid.UUID("00000000-0000-0000-0000-000000000000")

# Risk levels by priority. `_overall_risk` returns the highest of the
# three domain levels.
_RISK_PRIORITY = {"high_risk": 4, "medium_risk": 3, "low_risk": 2, "no_risk": 1}


def _overall_risk(security: Optional[str], compliance: Optional[str],
                  data: Optional[str]) -> str:
    """Highest-priority risk across the three domains. Mirrors the legacy
    `StatsService._get_highest_risk_level` so dashboard semantics are
    preserved."""
    p = max(
        _RISK_PRIORITY.get(security or "no_risk", 1),
        _RISK_PRIORITY.get(compliance or "no_risk", 1),
        _RISK_PRIORITY.get(data or "no_risk", 1),
    )
    for level, priority in _RISK_PRIORITY.items():
        if priority == p:
            return level
    return "no_risk"


def _bucket_date(created_at: Optional[datetime]) -> date:
    """Return the UTC date bucket for an event. NULL/naive timestamps fall
    back to today UTC — defensive only; production rows always carry
    server_default=now() in UTC."""
    if created_at is None:
        return datetime.now(timezone.utc).date()
    if created_at.tzinfo is None:
        return created_at.date()  # treat as UTC
    return created_at.astimezone(timezone.utc).date()


def _increment_columns(
    security: Optional[str],
    compliance: Optional[str],
    data: Optional[str],
) -> dict:
    """Per-row deltas for one detection. Caller adds these to the rollup row."""
    overall = _overall_risk(security, compliance, data)
    return {
        "total_count": 1,
        "security_count": 1 if (security or "no_risk") != "no_risk" else 0,
        "compliance_count": 1 if (compliance or "no_risk") != "no_risk" else 0,
        "data_count": 1 if (data or "no_risk") != "no_risk" else 0,
        "high_risk_count": 1 if overall == "high_risk" else 0,
        "medium_risk_count": 1 if overall == "medium_risk" else 0,
        "low_risk_count": 1 if overall == "low_risk" else 0,
        "no_risk_count": 1 if overall == "no_risk" else 0,
    }


def increment_for_detection(
    db: Session,
    *,
    tenant_id: uuid.UUID,
    application_id: Optional[uuid.UUID],
    created_at: Optional[datetime],
    security_risk_level: Optional[str],
    compliance_risk_level: Optional[str],
    data_risk_level: Optional[str],
) -> None:
    """Apply the per-row deltas to the rollup. Caller commits.

    Uses a SELECT-then-INSERT/UPDATE pattern rather than a dialect-aware
    UPSERT because we already need the row anyway for clarity and the
    write rate is whatever log_to_db_service polls at (batched, off the
    hot path). The unique constraint on (tenant_id, application_key,
    date) catches concurrent inserts; we retry on IntegrityError.
    """
    bucket = _bucket_date(created_at)
    deltas = _increment_columns(
        security_risk_level, compliance_risk_level, data_risk_level
    )
    app_key = application_id if application_id is not None else _SENTINEL_APPLICATION_KEY

    row = (
        db.query(TenantDetectionStats)
        .filter(
            TenantDetectionStats.tenant_id == tenant_id,
            TenantDetectionStats.application_key == app_key,
            TenantDetectionStats.date == bucket,
        )
        .one_or_none()
    )
    if row is None:
        row = TenantDetectionStats(
            tenant_id=tenant_id,
            application_id=application_id,
            date=bucket,
            **deltas,
        )
        db.add(row)
        return

    for col, delta in deltas.items():
        if delta:
            setattr(row, col, getattr(row, col) + delta)


def backfill_stats(db: Session, batch_size: int = 5000) -> dict:
    """Recompute the entire rollup from scratch by streaming
    `detection_results` in batches. Truncates the rollup first so the
    function is idempotent — running it twice produces the same result.

    Returns counts for observability.
    """
    db.execute(text("DELETE FROM tenant_detection_stats"))
    db.commit()

    rolled = {}  # (tenant_id, app_key, date) -> dict of counts
    total_scanned = 0
    last_id = 0

    while True:
        batch = (
            db.query(
                DetectionResult.id,
                DetectionResult.tenant_id,
                DetectionResult.application_id,
                DetectionResult.created_at,
                DetectionResult.security_risk_level,
                DetectionResult.compliance_risk_level,
                DetectionResult.data_risk_level,
            )
            .filter(DetectionResult.id > last_id)
            .order_by(DetectionResult.id)
            .limit(batch_size)
            .all()
        )
        if not batch:
            break

        for r in batch:
            last_id = r.id
            total_scanned += 1
            app_key = r.application_id if r.application_id is not None else _SENTINEL_APPLICATION_KEY
            key = (r.tenant_id, app_key, _bucket_date(r.created_at))
            cell = rolled.get(key)
            deltas = _increment_columns(
                r.security_risk_level, r.compliance_risk_level, r.data_risk_level
            )
            if cell is None:
                rolled[key] = dict(deltas)
            else:
                for col, delta in deltas.items():
                    cell[col] += delta

    # Bulk-insert the materialized rollup. Each row has a known
    # `application_id` (or NULL); the `application_key` gen col is
    # filled in by the DB.
    for (tenant_id, app_key, bucket), counts in rolled.items():
        application_id = None if app_key == _SENTINEL_APPLICATION_KEY else app_key
        db.add(
            TenantDetectionStats(
                tenant_id=tenant_id,
                application_id=application_id,
                date=bucket,
                **counts,
            )
        )
    db.commit()

    return {
        "rows_scanned": total_scanned,
        "rollup_rows": len(rolled),
    }
