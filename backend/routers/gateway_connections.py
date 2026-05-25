"""Gateway Connection Router - Manage third-party gateway integrations (Higress, LiteLLM)"""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified
from database.connection import get_admin_db
from database.models import GatewayConnection, Tenant
from typing import Optional, Dict, Any, List
from pydantic import BaseModel
from datetime import datetime
from utils.logger import setup_logger

logger = setup_logger()

router = APIRouter(prefix="/api/v1/gateway-connections", tags=["Gateway Connections"])

SUPPORTED_GATEWAY_TYPES = ["higress", "litellm"]

DEFAULT_CONFIGS = {
    "higress": {
        "auto_discovery_enabled": False,
    },
    "litellm": {},
}


def get_current_tenant_id(request: Request) -> str:
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if 'data' not in auth_context:
        raise HTTPException(status_code=401, detail="Invalid auth context")
    tenant_id = auth_context['data'].get('tenant_id')
    if not tenant_id:
        raise HTTPException(status_code=401, detail="Tenant ID not found in auth context")
    return str(tenant_id)


class GatewayConnectionResponse(BaseModel):
    id: str
    tenant_id: str
    gateway_type: str
    is_enabled: bool
    config: Dict[str, Any]
    api_key: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class UpdateGatewayConnectionRequest(BaseModel):
    is_enabled: Optional[bool] = None
    config: Optional[Dict[str, Any]] = None


def _ensure_defaults(db: Session, tenant_id: str) -> List[GatewayConnection]:
    """Ensure default gateway connection records exist for the tenant."""
    existing = db.query(GatewayConnection).filter(
        GatewayConnection.tenant_id == tenant_id
    ).all()

    existing_types = {conn.gateway_type for conn in existing}
    created = []

    for gw_type in SUPPORTED_GATEWAY_TYPES:
        if gw_type not in existing_types:
            conn = GatewayConnection(
                tenant_id=tenant_id,
                gateway_type=gw_type,
                is_enabled=False,
                config=DEFAULT_CONFIGS.get(gw_type, {}),
            )
            db.add(conn)
            created.append(conn)

    if created:
        db.commit()
        for c in created:
            db.refresh(c)

    return existing + created


def _get_tenant_api_key(db: Session, tenant_id: str) -> Optional[str]:
    """Get the tenant's API key for gateway authentication."""
    tenant = db.query(Tenant).filter(Tenant.id == tenant_id).first()
    return tenant.api_key if tenant else None


def _build_response(conn: GatewayConnection, api_key: Optional[str] = None) -> GatewayConnectionResponse:
    return GatewayConnectionResponse(
        id=str(conn.id),
        tenant_id=str(conn.tenant_id),
        gateway_type=conn.gateway_type,
        is_enabled=conn.is_enabled,
        config=conn.config or {},
        api_key=api_key if conn.is_enabled else None,
        created_at=conn.created_at,
        updated_at=conn.updated_at,
    )


@router.get("/", response_model=List[GatewayConnectionResponse])
async def list_gateway_connections(
    request: Request,
    db: Session = Depends(get_admin_db),
):
    tenant_id = get_current_tenant_id(request)
    connections = _ensure_defaults(db, tenant_id)
    api_key = _get_tenant_api_key(db, tenant_id)
    return [
        _build_response(conn, api_key)
        for conn in sorted(connections, key=lambda c: SUPPORTED_GATEWAY_TYPES.index(c.gateway_type))
    ]


@router.get("/{gateway_type}", response_model=GatewayConnectionResponse)
async def get_gateway_connection(
    gateway_type: str,
    request: Request,
    db: Session = Depends(get_admin_db),
):
    if gateway_type not in SUPPORTED_GATEWAY_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported gateway type: {gateway_type}")

    tenant_id = get_current_tenant_id(request)
    _ensure_defaults(db, tenant_id)

    conn = db.query(GatewayConnection).filter(
        GatewayConnection.tenant_id == tenant_id,
        GatewayConnection.gateway_type == gateway_type,
    ).first()

    api_key = _get_tenant_api_key(db, tenant_id)
    return _build_response(conn, api_key)


@router.put("/{gateway_type}", response_model=GatewayConnectionResponse)
async def update_gateway_connection(
    gateway_type: str,
    body: UpdateGatewayConnectionRequest,
    request: Request,
    db: Session = Depends(get_admin_db),
):
    if gateway_type not in SUPPORTED_GATEWAY_TYPES:
        raise HTTPException(status_code=400, detail=f"Unsupported gateway type: {gateway_type}")

    tenant_id = get_current_tenant_id(request)
    _ensure_defaults(db, tenant_id)

    conn = db.query(GatewayConnection).filter(
        GatewayConnection.tenant_id == tenant_id,
        GatewayConnection.gateway_type == gateway_type,
    ).first()

    if body.is_enabled is not None:
        conn.is_enabled = body.is_enabled
    if body.config is not None:
        # Create a new dict to ensure SQLAlchemy detects the change
        new_config = dict(conn.config or {})
        new_config.update(body.config)
        conn.config = new_config
        flag_modified(conn, 'config')

    db.commit()
    db.refresh(conn)

    logger.info(f"Gateway connection updated: tenant={tenant_id}, type={gateway_type}, enabled={conn.is_enabled}")

    api_key = _get_tenant_api_key(db, tenant_id)
    return _build_response(conn, api_key)
