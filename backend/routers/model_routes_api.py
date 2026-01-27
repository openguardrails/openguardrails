"""
Model Routes API - CRUD endpoints for model routing rules
"""
from fastapi import APIRouter, HTTPException, Request, Depends
from typing import List, Optional
from pydantic import BaseModel, Field, validator
import uuid

from database.connection import get_db
from database.models import ModelRoute, UpstreamApiConfig, Application
from services.model_route_service import model_route_service
from utils.logger import setup_logger

router = APIRouter(prefix="/api/v1/model-routes", tags=["Model Routes"])
logger = setup_logger()


# =====================================================
# Request/Response Models
# =====================================================

class ModelRouteCreateRequest(BaseModel):
    """Request model for creating a model route"""
    name: str = Field(..., description="Route name", min_length=1, max_length=200)
    description: Optional[str] = Field(None, description="Route description")
    model_pattern: str = Field(..., description="Model name pattern", min_length=1, max_length=255)
    match_type: str = Field("prefix", description="Match type: 'exact' or 'prefix'")
    upstream_api_config_id: str = Field(..., description="Upstream API config UUID")
    priority: int = Field(100, description="Priority (higher = more important)", ge=0, le=10000)
    application_ids: Optional[List[str]] = Field(None, description="Optional application UUIDs to bind to")

    @validator('match_type')
    def validate_match_type(cls, v):
        if v not in ['exact', 'prefix']:
            raise ValueError("match_type must be 'exact' or 'prefix'")
        return v


class ModelRouteUpdateRequest(BaseModel):
    """Request model for updating a model route"""
    name: Optional[str] = Field(None, description="Route name", min_length=1, max_length=200)
    description: Optional[str] = Field(None, description="Route description")
    model_pattern: Optional[str] = Field(None, description="Model name pattern", min_length=1, max_length=255)
    match_type: Optional[str] = Field(None, description="Match type: 'exact' or 'prefix'")
    upstream_api_config_id: Optional[str] = Field(None, description="Upstream API config UUID")
    priority: Optional[int] = Field(None, description="Priority (higher = more important)", ge=0, le=10000)
    is_active: Optional[bool] = Field(None, description="Whether the route is active")
    application_ids: Optional[List[str]] = Field(None, description="Application UUIDs (replaces existing)")

    @validator('match_type')
    def validate_match_type(cls, v):
        if v is not None and v not in ['exact', 'prefix']:
            raise ValueError("match_type must be 'exact' or 'prefix'")
        return v


class ApplicationInfo(BaseModel):
    """Application info for route response"""
    id: str
    name: str


class UpstreamApiInfo(BaseModel):
    """Upstream API config info for route response"""
    id: str
    config_name: str
    provider: Optional[str]


class ModelRouteResponse(BaseModel):
    """Response model for a model route"""
    id: str
    name: str
    description: Optional[str]
    model_pattern: str
    match_type: str
    upstream_api_config: UpstreamApiInfo
    priority: int
    is_active: bool
    applications: List[ApplicationInfo]
    created_at: str
    updated_at: str

    class Config:
        from_attributes = True


# =====================================================
# Helper Functions
# =====================================================

def get_tenant_id_from_request(request: Request) -> str:
    """Get tenant ID from request auth context"""
    auth_ctx = getattr(request.state, 'auth_context', None)
    if not auth_ctx:
        raise HTTPException(status_code=401, detail="Authentication required")
    return auth_ctx['data'].get('tenant_id')


def route_to_response(route: ModelRoute) -> ModelRouteResponse:
    """Convert ModelRoute to response model"""
    return ModelRouteResponse(
        id=str(route.id),
        name=route.name,
        description=route.description,
        model_pattern=route.model_pattern,
        match_type=route.match_type,
        upstream_api_config=UpstreamApiInfo(
            id=str(route.upstream_api_config.id),
            config_name=route.upstream_api_config.config_name,
            provider=route.upstream_api_config.provider
        ),
        priority=route.priority,
        is_active=route.is_active,
        applications=[
            ApplicationInfo(
                id=str(binding.application.id),
                name=binding.application.name
            )
            for binding in route.route_applications
        ],
        created_at=route.created_at.isoformat() if route.created_at else "",
        updated_at=route.updated_at.isoformat() if route.updated_at else ""
    )


# =====================================================
# API Endpoints
# =====================================================

@router.get("", response_model=List[ModelRouteResponse])
async def list_model_routes(
    request: Request,
    include_inactive: bool = False,
    db=Depends(get_db)
):
    """List all model routes for the current tenant"""
    tenant_id = get_tenant_id_from_request(request)

    routes = model_route_service.get_routes_for_tenant(
        db=db,
        tenant_id=tenant_id,
        include_inactive=include_inactive
    )

    return [route_to_response(route) for route in routes]


@router.get("/{route_id}", response_model=ModelRouteResponse)
async def get_model_route(
    route_id: str,
    request: Request,
    db=Depends(get_db)
):
    """Get a specific model route by ID"""
    tenant_id = get_tenant_id_from_request(request)

    route = model_route_service.get_route_by_id(
        db=db,
        route_id=route_id,
        tenant_id=tenant_id
    )

    if not route:
        raise HTTPException(status_code=404, detail="Route not found")

    return route_to_response(route)


@router.post("", response_model=ModelRouteResponse, status_code=201)
async def create_model_route(
    route_data: ModelRouteCreateRequest,
    request: Request,
    db=Depends(get_db)
):
    """Create a new model route"""
    tenant_id = get_tenant_id_from_request(request)

    # Validate upstream_api_config exists and belongs to tenant
    try:
        upstream_uuid = uuid.UUID(route_data.upstream_api_config_id)
        tenant_uuid = uuid.UUID(tenant_id)
        upstream_config = db.query(UpstreamApiConfig).filter(
            UpstreamApiConfig.id == upstream_uuid,
            UpstreamApiConfig.tenant_id == tenant_uuid
        ).first()

        if not upstream_config:
            raise HTTPException(status_code=400, detail="Invalid upstream_api_config_id")

    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid upstream_api_config_id format")

    # Validate application_ids if provided
    if route_data.application_ids:
        for app_id in route_data.application_ids:
            try:
                app_uuid = uuid.UUID(app_id)
                app = db.query(Application).filter(
                    Application.id == app_uuid,
                    Application.tenant_id == tenant_uuid
                ).first()
                if not app:
                    raise HTTPException(status_code=400, detail=f"Invalid application_id: {app_id}")
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Invalid application_id format: {app_id}")

    route = model_route_service.create_route(
        db=db,
        tenant_id=tenant_id,
        name=route_data.name,
        model_pattern=route_data.model_pattern,
        upstream_api_config_id=route_data.upstream_api_config_id,
        match_type=route_data.match_type,
        priority=route_data.priority,
        description=route_data.description,
        application_ids=route_data.application_ids
    )

    if not route:
        raise HTTPException(status_code=500, detail="Failed to create route")

    # Refresh to get relationships
    db.refresh(route)
    return route_to_response(route)


@router.put("/{route_id}", response_model=ModelRouteResponse)
async def update_model_route(
    route_id: str,
    route_data: ModelRouteUpdateRequest,
    request: Request,
    db=Depends(get_db)
):
    """Update an existing model route"""
    tenant_id = get_tenant_id_from_request(request)
    tenant_uuid = uuid.UUID(tenant_id)

    # Validate upstream_api_config if provided
    if route_data.upstream_api_config_id:
        try:
            upstream_uuid = uuid.UUID(route_data.upstream_api_config_id)
            upstream_config = db.query(UpstreamApiConfig).filter(
                UpstreamApiConfig.id == upstream_uuid,
                UpstreamApiConfig.tenant_id == tenant_uuid
            ).first()

            if not upstream_config:
                raise HTTPException(status_code=400, detail="Invalid upstream_api_config_id")

        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid upstream_api_config_id format")

    # Validate application_ids if provided
    if route_data.application_ids is not None:
        for app_id in route_data.application_ids:
            try:
                app_uuid = uuid.UUID(app_id)
                app = db.query(Application).filter(
                    Application.id == app_uuid,
                    Application.tenant_id == tenant_uuid
                ).first()
                if not app:
                    raise HTTPException(status_code=400, detail=f"Invalid application_id: {app_id}")
            except ValueError:
                raise HTTPException(status_code=400, detail=f"Invalid application_id format: {app_id}")

    # Build updates dict excluding None values and application_ids
    updates = {}
    for key, value in route_data.dict(exclude={'application_ids'}).items():
        if value is not None:
            updates[key] = value

    route = model_route_service.update_route(
        db=db,
        route_id=route_id,
        tenant_id=tenant_id,
        updates=updates,
        application_ids=route_data.application_ids
    )

    if not route:
        raise HTTPException(status_code=404, detail="Route not found")

    # Refresh to get relationships
    db.refresh(route)
    return route_to_response(route)


@router.delete("/{route_id}")
async def delete_model_route(
    route_id: str,
    request: Request,
    db=Depends(get_db)
):
    """Delete a model route"""
    tenant_id = get_tenant_id_from_request(request)

    success = model_route_service.delete_route(
        db=db,
        route_id=route_id,
        tenant_id=tenant_id
    )

    if not success:
        raise HTTPException(status_code=404, detail="Route not found")

    return {"success": True, "message": "Route deleted successfully"}


@router.get("/test/{model_name}")
async def test_model_routing(
    model_name: str,
    request: Request,
    application_id: Optional[str] = None,
    db=Depends(get_db)
):
    """Test model routing - find which upstream API would be used for a model name"""
    tenant_id = get_tenant_id_from_request(request)

    upstream_config = model_route_service.find_matching_route(
        db=db,
        tenant_id=tenant_id,
        model_name=model_name,
        application_id=application_id
    )

    if not upstream_config:
        return {
            "matched": False,
            "model_name": model_name,
            "message": "No matching route found. Please configure a routing rule for this model."
        }

    return {
        "matched": True,
        "model_name": model_name,
        "upstream_api_config": {
            "id": str(upstream_config.id),
            "config_name": upstream_config.config_name,
            "provider": upstream_config.provider,
            "api_base_url": upstream_config.api_base_url
        }
    }
