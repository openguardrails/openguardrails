"""Migration 095: hoist stripe_session_id / trade_no out of order_metadata.

Phase 4a: replaces the PG-only `order_metadata->>'stripe_session_id'` and
`order_metadata->>'trade_no'` text expressions in
`routers/payment_api.py` with indexed real columns. ORM models declare
both columns; this migration adds them to the live schema and backfills
from existing rows. JSON-extraction syntax is dialect-specific so the
migration is a `.py` and branches on `conn.dialect.name`.

Idempotent: ADD COLUMN IF NOT EXISTS for PG; probe `information_schema`
for MySQL. Backfill is `WHERE col IS NULL` so re-runs on already-hoisted
rows are safe.
"""

from __future__ import annotations

from sqlalchemy import text


def _column_exists_mysql(conn, table: str, column: str) -> bool:
    return bool(
        conn.execute(
            text(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_schema = DATABASE() "
                "  AND table_name = :t AND column_name = :c "
                "LIMIT 1"
            ),
            {"t": table, "c": column},
        ).first()
    )


def upgrade(conn) -> None:
    dialect = conn.dialect.name

    if dialect == "postgresql":
        conn.execute(
            text(
                "ALTER TABLE payment_orders "
                "ADD COLUMN IF NOT EXISTS stripe_session_id VARCHAR(255)"
            )
        )
        conn.execute(
            text(
                "ALTER TABLE payment_orders "
                "ADD COLUMN IF NOT EXISTS trade_no VARCHAR(255)"
            )
        )
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_payment_orders_stripe_session_id "
                "ON payment_orders (stripe_session_id)"
            )
        )
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_payment_orders_trade_no "
                "ON payment_orders (trade_no)"
            )
        )
        # Backfill from JSON column. `->>` returns text on both JSON and
        # JSONB; the `IS NOT NULL` guard naturally handles missing keys
        # without needing the JSONB-only `?` containment operator.
        conn.execute(
            text(
                "UPDATE payment_orders "
                "SET stripe_session_id = order_metadata->>'stripe_session_id' "
                "WHERE stripe_session_id IS NULL "
                "  AND order_metadata->>'stripe_session_id' IS NOT NULL"
            )
        )
        conn.execute(
            text(
                "UPDATE payment_orders "
                "SET trade_no = order_metadata->>'trade_no' "
                "WHERE trade_no IS NULL "
                "  AND order_metadata->>'trade_no' IS NOT NULL"
            )
        )

    elif dialect in ("mysql", "mariadb"):
        if not _column_exists_mysql(conn, "payment_orders", "stripe_session_id"):
            conn.execute(
                text("ALTER TABLE payment_orders ADD COLUMN stripe_session_id VARCHAR(255)")
            )
        if not _column_exists_mysql(conn, "payment_orders", "trade_no"):
            conn.execute(
                text("ALTER TABLE payment_orders ADD COLUMN trade_no VARCHAR(255)")
            )
        # MySQL has no CREATE INDEX IF NOT EXISTS — probe.
        existing = conn.execute(
            text(
                "SELECT index_name FROM information_schema.statistics "
                "WHERE table_schema = DATABASE() AND table_name = 'payment_orders' "
                "  AND index_name IN ('ix_payment_orders_stripe_session_id', "
                "                     'ix_payment_orders_trade_no')"
            )
        ).all()
        existing_names = {row[0] for row in existing}
        if "ix_payment_orders_stripe_session_id" not in existing_names:
            conn.execute(
                text(
                    "CREATE INDEX ix_payment_orders_stripe_session_id "
                    "ON payment_orders (stripe_session_id)"
                )
            )
        if "ix_payment_orders_trade_no" not in existing_names:
            conn.execute(
                text("CREATE INDEX ix_payment_orders_trade_no ON payment_orders (trade_no)")
            )
        # Backfill via JSON_UNQUOTE(JSON_EXTRACT(...)). Returns NULL when key missing,
        # so the WHERE clause naturally excludes those.
        conn.execute(
            text(
                "UPDATE payment_orders "
                "SET stripe_session_id = JSON_UNQUOTE(JSON_EXTRACT(order_metadata, '$.stripe_session_id')) "
                "WHERE stripe_session_id IS NULL "
                "  AND JSON_EXTRACT(order_metadata, '$.stripe_session_id') IS NOT NULL"
            )
        )
        conn.execute(
            text(
                "UPDATE payment_orders "
                "SET trade_no = JSON_UNQUOTE(JSON_EXTRACT(order_metadata, '$.trade_no')) "
                "WHERE trade_no IS NULL "
                "  AND JSON_EXTRACT(order_metadata, '$.trade_no') IS NOT NULL"
            )
        )

    else:
        raise RuntimeError(f"Unsupported dialect for migration 095: {dialect}")
