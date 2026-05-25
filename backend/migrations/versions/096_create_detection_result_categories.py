"""Migration 096: relational projection of detection_results categories.

Phase 4a Step 4.2: introduces `detection_result_categories` so the
log-listing endpoint can filter by category without
`cast(security_categories, JSONB).contains([cat])` (PG-only). Each
detection result with non-empty `security_categories`,
`compliance_categories`, or `data_categories` produces N rows here, one
per category, scoped by `kind`.

Backfill is dialect-aware:
  - PG: `jsonb_array_elements_text` over each JSON column. Cast `JSON`
    to `jsonb` since PG `json` lacks the array-element function.
  - MySQL: `JSON_TABLE` materializes each array element as a row. Same
    intent, different syntax.

Idempotent. The unique key (result_id, kind, category) on the target
table guarantees re-runs deduplicate. Application-level dual-write in
log_to_db_service.py keeps new rows in sync going forward.
"""

from __future__ import annotations

from sqlalchemy import text


def _table_exists_mysql(conn, table: str) -> bool:
    return bool(
        conn.execute(
            text(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = DATABASE() AND table_name = :t LIMIT 1"
            ),
            {"t": table},
        ).first()
    )


def upgrade(conn) -> None:
    dialect = conn.dialect.name

    # The ORM owns the table definition. `Base.metadata.create_all()` for
    # this single table is the dialect-portable shortcut to render exactly
    # the same DDL the bootstrap migration would. Skip when the table is
    # already present so re-runs are no-ops.
    from database.models import Base, DetectionResultCategory

    if dialect == "postgresql":
        already = conn.execute(
            text(
                "SELECT 1 FROM information_schema.tables "
                "WHERE table_schema = 'public' AND table_name = 'detection_result_categories'"
            )
        ).first()
    elif dialect in ("mysql", "mariadb"):
        already = _table_exists_mysql(conn, "detection_result_categories")
    else:
        raise RuntimeError(f"Unsupported dialect for migration 096: {dialect}")

    if not already:
        DetectionResultCategory.__table__.create(bind=conn)

    # Backfill from existing JSON columns. Dialect-aware unnesting.
    if dialect == "postgresql":
        # `cast(... as jsonb)` because the column type is `json` on some
        # legacy installs (and JSON on the ORM); jsonb_array_elements_text
        # only accepts jsonb.
        for kind, col in (
            ("security", "security_categories"),
            ("compliance", "compliance_categories"),
            ("data", "data_categories"),
        ):
            conn.execute(
                text(
                    f"""
                    INSERT INTO detection_result_categories (result_id, kind, category)
                    SELECT
                        dr.id,
                        :kind,
                        elem
                    FROM detection_results dr
                    CROSS JOIN LATERAL jsonb_array_elements_text(
                        CAST(dr.{col} AS jsonb)
                    ) AS elem
                    WHERE dr.{col} IS NOT NULL
                      AND CAST(dr.{col} AS text) NOT IN ('null', '[]')
                    ON CONFLICT (result_id, kind, category) DO NOTHING
                    """
                ),
                {"kind": kind},
            )
    else:  # mysql / mariadb
        for kind, col in (
            ("security", "security_categories"),
            ("compliance", "compliance_categories"),
            ("data", "data_categories"),
        ):
            # JSON_TABLE was added in MySQL 8.0; safe for our target.
            # `INSERT IGNORE` covers the unique-key dedup.
            conn.execute(
                text(
                    f"""
                    INSERT IGNORE INTO detection_result_categories (result_id, kind, category)
                    SELECT
                        dr.id,
                        :kind,
                        jt.category_value
                    FROM detection_results dr
                    JOIN JSON_TABLE(
                        dr.{col},
                        '$[*]' COLUMNS (category_value VARCHAR(100) PATH '$')
                    ) AS jt
                    WHERE dr.{col} IS NOT NULL
                      AND JSON_LENGTH(dr.{col}) > 0
                    """
                ),
                {"kind": kind},
            )
