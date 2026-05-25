"""System config router (super-admin only).

Exposes the global retention settings that drive
`services/retention_purger.py`. All endpoints require
`is_super_admin = true`; tenant admins cannot read or write these.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from database.connection import get_admin_db
from database.models import Tenant
from services.admin_service import admin_service
from services.retention_service import (
    DEFAULT_METADATA_RETENTION_DAYS,
    DEFAULT_PAYLOAD_RETENTION_DAYS,
    get_metadata_retention_days,
    get_payload_retention_days,
    set_metadata_retention_days,
    set_payload_retention_days,
)
from utils.logger import setup_logger

logger = setup_logger()
router = APIRouter(tags=["System Config"])


class RetentionConfig(BaseModel):
    payload_retention_days: int = Field(
        ...,
        ge=0,
        description="Days to keep detection payload (content / messages / model_response). "
                    "0 disables payload purging.",
    )
    metadata_retention_days: int = Field(
        ...,
        ge=0,
        description="Days to keep detection metadata rows. 0 keeps metadata forever.",
    )


def _require_super_admin(request: Request, db: Session) -> Tenant:
    auth = getattr(request.state, "auth_context", None)
    if not auth or "data" not in auth:
        raise HTTPException(status_code=401, detail="Not authenticated")
    tenant_id = auth["data"].get("tenant_id")
    if not tenant_id:
        raise HTTPException(status_code=401, detail="Tenant ID missing")
    tenant = db.query(Tenant).filter(Tenant.id == tenant_id).one_or_none()
    if tenant is None:
        raise HTTPException(status_code=404, detail="Tenant not found")
    if not admin_service.is_super_admin(tenant):
        raise HTTPException(status_code=403, detail="Super admin required")
    return tenant


@router.get("/system/retention", response_model=RetentionConfig)
async def get_retention_config(request: Request, db: Session = Depends(get_admin_db)):
    """Get the current global retention windows. Super-admin only."""
    _require_super_admin(request, db)
    return RetentionConfig(
        payload_retention_days=get_payload_retention_days(db),
        metadata_retention_days=get_metadata_retention_days(db),
    )


@router.put("/system/retention", response_model=RetentionConfig)
async def update_retention_config(
    config: RetentionConfig,
    request: Request,
    db: Session = Depends(get_admin_db),
):
    """Update both retention windows. Takes effect on the next purge cycle
    (within 24h). Super-admin only.

    Validation: metadata_retention_days, when non-zero, must be >=
    payload_retention_days — otherwise the purger would delete metadata
    while payload is still inside its window, which is incoherent.
    """
    admin = _require_super_admin(request, db)

    if (
        config.metadata_retention_days != 0
        and config.metadata_retention_days < config.payload_retention_days
    ):
        raise HTTPException(
            status_code=400,
            detail="metadata_retention_days must be 0 (forever) or >= payload_retention_days",
        )

    set_payload_retention_days(db, config.payload_retention_days)
    set_metadata_retention_days(db, config.metadata_retention_days)
    db.commit()

    logger.info(
        "Retention config updated by super-admin %s: payload=%d days, metadata=%d days",
        admin.email,
        config.payload_retention_days,
        config.metadata_retention_days,
    )

    return config


@router.get("/system/retention/defaults", response_model=RetentionConfig)
async def get_retention_defaults(request: Request, db: Session = Depends(get_admin_db)):
    """Return the built-in defaults (payload=30, metadata=0). Super-admin only.

    The frontend uses this to render a "Reset to defaults" affordance
    without hardcoding values that may change in future releases.
    """
    _require_super_admin(request, db)
    return RetentionConfig(
        payload_retention_days=DEFAULT_PAYLOAD_RETENTION_DAYS,
        metadata_retention_days=DEFAULT_METADATA_RETENTION_DAYS,
    )
