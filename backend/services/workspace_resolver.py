"""
Workspace Resolver - resolves workspace_id from application_id.

All configuration lives at workspace level. This utility provides
the mapping from application_id to workspace_id for detection services.

Phase 3: each helper has both a sync and `_async` variant. Sync callers
(routers using `Session`, the un-migrated services) keep using the
original signatures; async callers on the detection hot path use the
`_async` variants. Once all callers migrate, the sync versions can be
dropped — they share zero state, so removal is mechanical.
"""

from typing import Optional
from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.ext.asyncio import AsyncSession
from database.models import Application, Workspace
from utils.logger import setup_logger

logger = setup_logger()

# In-memory cache for app → workspace mapping (refreshed per-request via DB session)
_app_workspace_cache = {}


# ---------------------------------------------------------------------------
# Sync API (legacy — kept for un-migrated callers).
# ---------------------------------------------------------------------------


def get_workspace_id_for_app(db: Session, application_id: str) -> Optional[str]:
    """Get workspace_id for an application.

    All applications should have a workspace (global workspace for unassigned apps).
    Returns None only if the application doesn't exist.
    """
    if not application_id:
        return None

    try:
        app = db.query(Application.workspace_id).filter(
            Application.id == application_id
        ).first()

        if app and app.workspace_id:
            return str(app.workspace_id)

        logger.warning(f"Application {application_id} has no workspace_id")
        return None
    except Exception as e:
        logger.error(f"Failed to resolve workspace for app {application_id}: {e}")
        return None


def get_global_workspace_id(db: Session, tenant_id: str) -> Optional[str]:
    """Get the global workspace for a tenant."""
    if not tenant_id:
        return None

    try:
        ws = db.query(Workspace.id).filter(
            Workspace.tenant_id == tenant_id,
            Workspace.is_global == True
        ).first()

        if ws:
            return str(ws.id)

        logger.warning(f"No global workspace found for tenant {tenant_id}")
        return None
    except Exception as e:
        logger.error(f"Failed to get global workspace for tenant {tenant_id}: {e}")
        return None


def ensure_global_workspace(db: Session, tenant_id: str) -> str:
    """Ensure a global workspace exists for the tenant, create if missing.
    Returns the global workspace ID."""
    import uuid as uuid_mod

    existing = get_global_workspace_id(db, tenant_id)
    if existing:
        return existing

    ws = Workspace(
        tenant_id=uuid_mod.UUID(str(tenant_id)),
        name="Global",
        description="Default global workspace",
        is_global=True,
    )
    db.add(ws)
    db.flush()
    logger.info(f"Created global workspace {ws.id} for tenant {tenant_id}")
    return str(ws.id)


# ---------------------------------------------------------------------------
# Async API — Phase 3. Same semantics, takes AsyncSession.
# ---------------------------------------------------------------------------


async def get_workspace_id_for_app_async(db: AsyncSession, application_id: str) -> Optional[str]:
    """Async variant of get_workspace_id_for_app. See that function for semantics."""
    if not application_id:
        return None

    try:
        res = await db.execute(
            select(Application.workspace_id).where(Application.id == application_id)
        )
        ws_id = res.scalar_one_or_none()
        if ws_id:
            return str(ws_id)

        logger.warning(f"Application {application_id} has no workspace_id")
        return None
    except Exception as e:
        logger.error(f"Failed to resolve workspace for app {application_id}: {e}")
        return None


async def get_global_workspace_id_async(db: AsyncSession, tenant_id: str) -> Optional[str]:
    """Async variant of get_global_workspace_id."""
    if not tenant_id:
        return None

    try:
        res = await db.execute(
            select(Workspace.id).where(
                Workspace.tenant_id == tenant_id,
                Workspace.is_global == True,  # noqa: E712
            )
        )
        ws_id = res.scalar_one_or_none()
        if ws_id:
            return str(ws_id)

        logger.warning(f"No global workspace found for tenant {tenant_id}")
        return None
    except Exception as e:
        logger.error(f"Failed to get global workspace for tenant {tenant_id}: {e}")
        return None


async def ensure_global_workspace_async(db: AsyncSession, tenant_id: str) -> str:
    """Async variant of ensure_global_workspace. Caller is responsible
    for committing the session if a new workspace is created — `flush`
    here makes the new row visible to subsequent reads on the same
    session, but persistence still requires `await db.commit()`."""
    import uuid as uuid_mod

    existing = await get_global_workspace_id_async(db, tenant_id)
    if existing:
        return existing

    ws = Workspace(
        tenant_id=uuid_mod.UUID(str(tenant_id)),
        name="Global",
        description="Default global workspace",
        is_global=True,
    )
    db.add(ws)
    await db.flush()
    logger.info(f"Created global workspace {ws.id} for tenant {tenant_id}")
    return str(ws.id)
