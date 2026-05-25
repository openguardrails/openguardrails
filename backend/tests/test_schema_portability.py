"""Schema-portability tests.

These run on both PostgreSQL and MySQL via the CI matrix (and
identically when DATABASE_URL points at either). They codify the
guarantees Phase 4a depends on:

  - `Base.metadata.create_all()` produces an index-complete schema on
    both dialects (Step 3A.2.a/b).
  - The migration pipeline (000 + Phase-4 deltas) is idempotent —
    re-running stamps everything as applied without DDL changes.
  - The generated-column unique constraints encode the partial-unique
    semantics correctly on both dialects (Step 3A.2.b).
  - The detection-data lifecycle (Step 7) wires up correctly:
    retention purge, stats rollup, payload sibling.

Tests are intentionally narrow — each one has one assertion target.
Every test starts from a fresh DB (per-test isolation).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError

from tests.conftest import dialect


def test_bootstrap_creates_all_orm_tables(bootstrapped_engine):
    """Every table declared in models.py must exist after bootstrap."""
    from database.models import Base

    insp = inspect(bootstrapped_engine)
    db_tables = set(insp.get_table_names())
    orm_tables = set(Base.metadata.tables.keys())

    missing = orm_tables - db_tables
    assert not missing, f"ORM tables missing from DB: {sorted(missing)}"


def test_bootstrap_no_extra_tables(bootstrapped_engine):
    """The DB should only contain ORM tables + schema_migrations.
    Anything else means a stray CREATE TABLE leaked through."""
    from database.models import Base

    insp = inspect(bootstrapped_engine)
    db_tables = set(insp.get_table_names())
    orm_tables = set(Base.metadata.tables.keys())

    extra = db_tables - orm_tables - {"schema_migrations"}
    assert not extra, f"Unexpected tables: {sorted(extra)}"


def test_bootstrap_is_idempotent(bootstrapped_engine):
    """Running the migration runner a second time must not change anything."""
    from migrations.run_migrations import run_migrations

    executed, failed = run_migrations()
    assert failed == 0
    assert executed == 0, "Second run should find everything stamped"


def test_payload_sibling_table_present(bootstrapped_engine):
    """Step 7.2: detection_result_payloads is a real sibling of
    detection_results, not just a relationship in the ORM."""
    insp = inspect(bootstrapped_engine)
    assert "detection_result_payloads" in insp.get_table_names()


def test_stats_rollup_table_present(bootstrapped_engine):
    """Step 7.4: tenant_detection_stats exists with the gen-col unique."""
    insp = inspect(bootstrapped_engine)
    assert "tenant_detection_stats" in insp.get_table_names()
    cols = {c["name"] for c in insp.get_columns("tenant_detection_stats")}
    assert "application_key" in cols, "Generated column for unique constraint missing"


def test_categories_table_present(bootstrapped_engine):
    """Step 4.2: detection_result_categories present."""
    insp = inspect(bootstrapped_engine)
    assert "detection_result_categories" in insp.get_table_names()


def test_workspace_global_unique_via_generated_column(db_session):
    """Step 3A.2.b regression: only one `is_global=true` workspace per
    tenant, enforced via the generated `global_tenant_key` column.

    Both PG (STORED) and MySQL (VIRTUAL) must enforce this. Two
    `is_global=false` workspaces for the same tenant should remain
    allowed, since the gen col evaluates to NULL for them.
    """
    from database.models import Tenant, Workspace

    tenant = Tenant(
        email=f"t-{uuid.uuid4()}@example.com",
        password_hash="x",
        api_key=f"k-{uuid.uuid4()}",
        log_direct_model_access=False,
        language="en",
    )
    db_session.add(tenant)
    db_session.flush()

    db_session.add(Workspace(tenant_id=tenant.id, name="g1", is_global=True))
    db_session.commit()

    # Second global must fail
    db_session.add(Workspace(tenant_id=tenant.id, name="g2", is_global=True))
    with pytest.raises(IntegrityError):
        db_session.commit()
    db_session.rollback()

    # Multiple non-global workspaces are fine
    db_session.add(Workspace(tenant_id=tenant.id, name="ng1", is_global=False))
    db_session.add(Workspace(tenant_id=tenant.id, name="ng2", is_global=False))
    db_session.commit()


def test_detection_dual_write_to_payload_and_categories(db_session):
    """log_to_db_service-style insert must populate the categories +
    payload siblings via the relationships. We construct the rows
    directly here rather than going through the JSONL pipeline."""
    from database.models import (
        Application,
        DetectionResult,
        DetectionResultCategory,
        DetectionResultPayload,
        Tenant,
        Workspace,
    )

    tenant = Tenant(
        email=f"t-{uuid.uuid4()}@example.com",
        password_hash="x",
        api_key=f"k-{uuid.uuid4()}",
        log_direct_model_access=False,
        language="en",
    )
    db_session.add(tenant)
    db_session.flush()

    workspace = Workspace(tenant_id=tenant.id, name="ws", is_global=False)
    db_session.add(workspace)
    db_session.flush()

    app = Application(tenant_id=tenant.id, workspace_id=workspace.id, name="app1")
    db_session.add(app)
    db_session.flush()

    dr = DetectionResult(
        request_id=f"req-{uuid.uuid4()}",
        tenant_id=tenant.id,
        application_id=app.id,
        content="hello world",
        suggest_action="pass",
        security_risk_level="no_risk",
        compliance_risk_level="medium_risk",
        data_risk_level="no_risk",
        security_categories=[],
        compliance_categories=["S1"],
        data_categories=[],
    )
    dr.payload = DetectionResultPayload(
        content="hello world",
        full_messages=[{"role": "user", "content": "hello world"}],
    )
    dr.categories.append(DetectionResultCategory(kind="compliance", category="S1"))
    db_session.add(dr)
    db_session.commit()

    # Reload and assert the sibling rows actually landed
    dr_reloaded = db_session.query(DetectionResult).filter_by(request_id=dr.request_id).one()
    assert dr_reloaded.payload is not None
    assert dr_reloaded.payload.content == "hello world"
    assert len(dr_reloaded.categories) == 1
    assert dr_reloaded.categories[0].category == "S1"


def test_retention_purge_drops_payload_sibling(db_session):
    """Step 7.2 + 7.3: payload retention purge cleans the sibling row
    via DELETE (cheaper than the wide UPDATE) and the legacy fields too."""
    from database.models import (
        Application,
        DetectionResult,
        DetectionResultPayload,
        Tenant,
        Workspace,
    )
    from services.retention_service import (
        purge_old_detection_data,
        set_payload_retention_days,
    )

    tenant = Tenant(
        email=f"t-{uuid.uuid4()}@example.com",
        password_hash="x",
        api_key=f"k-{uuid.uuid4()}",
        log_direct_model_access=False,
        language="en",
    )
    db_session.add(tenant)
    db_session.flush()
    ws = Workspace(tenant_id=tenant.id, name="ws", is_global=False)
    db_session.add(ws)
    db_session.flush()
    app = Application(tenant_id=tenant.id, workspace_id=ws.id, name="app1")
    db_session.add(app)
    db_session.flush()

    # Old enough to be purged (10 days back)
    old_when = datetime.now(timezone.utc) - timedelta(days=10)
    fresh_when = datetime.now(timezone.utc) - timedelta(hours=1)

    for label, when in [("old", old_when), ("fresh", fresh_when)]:
        dr = DetectionResult(
            request_id=f"req-{label}-{uuid.uuid4()}",
            tenant_id=tenant.id,
            application_id=app.id,
            content=f"content-{label}",
            suggest_action="pass",
            security_risk_level="no_risk",
            compliance_risk_level="no_risk",
            data_risk_level="no_risk",
            security_categories=[],
            compliance_categories=[],
            data_categories=[],
            created_at=when,
        )
        dr.payload = DetectionResultPayload(content=f"content-{label}")
        db_session.add(dr)
    db_session.commit()

    # Set retention to 1 day; old row should lose its sibling, fresh row should keep it.
    set_payload_retention_days(db_session, 1)
    db_session.commit()
    stats = purge_old_detection_data(db_session)

    assert stats["payload_rows_deleted"] >= 1, stats
    # Filter by this test's tenant so leftover rows from other tests
    # don't influence the count.
    remaining_for_tenant = (
        db_session.query(DetectionResultPayload)
        .join(DetectionResult, DetectionResult.id == DetectionResultPayload.detection_result_id)
        .filter(DetectionResult.tenant_id == tenant.id)
        .count()
    )
    assert remaining_for_tenant == 1, "Only the fresh detection_result's payload should survive"

    # Reset retention so following tests aren't affected.
    set_payload_retention_days(db_session, 30)
    db_session.commit()


def test_stats_rollup_increment(db_session):
    """Step 7.4: increment_for_detection adds a rollup row on first call,
    bumps it on subsequent calls for the same (tenant, app, date)."""
    from database.models import Application, Tenant, TenantDetectionStats, Workspace
    from services.detection_stats_service import increment_for_detection

    tenant = Tenant(
        email=f"t-{uuid.uuid4()}@example.com",
        password_hash="x",
        api_key=f"k-{uuid.uuid4()}",
        log_direct_model_access=False,
        language="en",
    )
    db_session.add(tenant)
    db_session.flush()
    ws = Workspace(tenant_id=tenant.id, name="ws", is_global=False)
    db_session.add(ws)
    db_session.flush()
    app = Application(tenant_id=tenant.id, workspace_id=ws.id, name="app1")
    db_session.add(app)
    db_session.flush()

    when = datetime.now(timezone.utc)

    for level in ("high_risk", "medium_risk", "no_risk"):
        increment_for_detection(
            db_session,
            tenant_id=tenant.id,
            application_id=app.id,
            created_at=when,
            security_risk_level=level,
            compliance_risk_level="no_risk",
            data_risk_level="no_risk",
        )
    db_session.commit()

    rows = db_session.query(TenantDetectionStats).filter_by(tenant_id=tenant.id).all()
    assert len(rows) == 1, "All increments are same (tenant, app, date) bucket"
    row = rows[0]
    assert row.total_count == 3
    assert row.security_count == 2  # high_risk + medium_risk count as security non-no_risk
    assert row.high_risk_count == 1
    assert row.medium_risk_count == 1
    assert row.no_risk_count == 1


def test_payment_order_indexed_columns_present(bootstrapped_engine):
    """Step 4.1: the JSONB hoist added stripe_session_id / trade_no
    columns and indexes. Verify both are real columns on the live
    schema."""
    insp = inspect(bootstrapped_engine)
    cols = {c["name"] for c in insp.get_columns("payment_orders")}
    assert "stripe_session_id" in cols
    assert "trade_no" in cols

    idx_names = {i["name"] for i in insp.get_indexes("payment_orders")}
    # The names differ subtly between dialects (CREATE INDEX vs SQLAlchemy auto-name)
    # but both bootstrap variants converge on `ix_payment_orders_*` from the ORM.
    assert any("stripe_session_id" in n for n in idx_names), idx_names
    assert any("trade_no" in n for n in idx_names), idx_names


def test_legacy_triggers_removed_on_postgres(bootstrapped_engine):
    """Step 3A.2.c: the four updated_at triggers and the
    trigger_campaign_number trigger should not exist on a freshly-
    bootstrapped DB. MySQL never had them; this is a PG-only assertion."""
    if dialect(bootstrapped_engine) != "postgresql":
        pytest.skip("PG-only: MySQL doesn't have those legacy triggers")

    with bootstrapped_engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT trigger_name FROM information_schema.triggers "
                "WHERE trigger_schema = 'public'"
            )
        ).all()
    trigger_names = {r[0] for r in rows}
    legacy = {
        "trg_appeal_config_updated_at",
        "trg_appeal_records_updated_at",
        "update_payment_orders_updated_at",
        "update_subscription_payments_updated_at",
        "trigger_campaign_number",
    }
    overlap = trigger_names & legacy
    assert not overlap, f"Legacy triggers present: {overlap}"
