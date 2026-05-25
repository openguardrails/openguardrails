"""Migration 099: split detection_results heavy fields into a sibling
table (Step 7.2).

Creates `detection_result_payloads` from `Base.metadata.create_all()`
(portable PG/MySQL DDL) and backfills it from the existing
`detection_results` rows. Going forward, log_to_db_service writes to
both — reader migration off the legacy columns is a follow-up.

The backfill scans `detection_results.id` in batches and bulk-inserts
into the sibling. Idempotent: skips rows that already have a payload
sibling, so re-running is a no-op once the table is populated.
"""

from __future__ import annotations

from sqlalchemy import inspect, text


def upgrade(conn) -> None:
    from database.models import Base, DetectionResultPayload

    inspector = inspect(conn)
    if "detection_result_payloads" not in inspector.get_table_names():
        DetectionResultPayload.__table__.create(bind=conn)

    # Backfill in batches. We INSERT ... SELECT ... LEFT JOIN to find rows
    # without a sibling yet. Both PG and MySQL support this form.
    # Batch size is 5000 — hits a reasonable balance for in-memory log
    # buffers. On very large tables (millions of rows) this migration
    # will take minutes; that's a one-time cost during deploy.
    batch_size = 5000
    inserted_total = 0
    while True:
        result = conn.execute(
            text(
                """
                INSERT INTO detection_result_payloads (
                    detection_result_id,
                    content,
                    original_content,
                    model_response,
                    full_messages,
                    messages,
                    image_paths,
                    unsafe_segments,
                    doublecheck_categories,
                    doublecheck_reasoning,
                    matched_window_indices
                )
                SELECT
                    dr.id,
                    dr.content,
                    dr.original_content,
                    dr.model_response,
                    dr.full_messages,
                    dr.messages,
                    dr.image_paths,
                    dr.unsafe_segments,
                    dr.doublecheck_categories,
                    dr.doublecheck_reasoning,
                    dr.matched_window_indices
                FROM detection_results dr
                LEFT JOIN detection_result_payloads p
                    ON p.detection_result_id = dr.id
                WHERE p.detection_result_id IS NULL
                ORDER BY dr.id
                LIMIT :batch
                """
            ),
            {"batch": batch_size},
        )
        rowcount = result.rowcount or 0
        inserted_total += rowcount
        if rowcount < batch_size:
            break

    if inserted_total:
        import logging
        logging.getLogger(__name__).info(
            "Migration 099 backfill: inserted %d payload rows", inserted_total
        )
