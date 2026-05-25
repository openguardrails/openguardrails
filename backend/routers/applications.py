"""Application Management Router - CRUD operations for applications and API keys"""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from database.connection import get_admin_db
from database.models import (
    Application, ApiKey, Tenant, RiskTypeConfig,
    DataSecurityEntityType, ResponseTemplate, Blacklist, Whitelist, KnowledgeBase,
    ApplicationScannerConfig, Scanner, Workspace
)
from services.scanner_config_service import ScannerConfigService
from typing import List, Optional, Dict, Any
from pydantic import BaseModel
from datetime import datetime
import uuid
from utils.logger import setup_logger
from services.audit_log_service import log_operation, compute_changes

logger = setup_logger()

router = APIRouter(tags=["Applications"])

def get_current_tenant_id(request: Request) -> str:
    """Get current tenant ID from request context"""
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context:
        raise HTTPException(status_code=401, detail="Not authenticated")

    if 'data' not in auth_context:
        raise HTTPException(status_code=401, detail="Invalid auth context")

    tenant_id = auth_context['data'].get('tenant_id')
    if not tenant_id:
        raise HTTPException(status_code=401, detail="Tenant ID not found in auth context")

    return str(tenant_id)

# Pydantic models
class ApplicationCreate(BaseModel):
    name: str
    description: Optional[str] = None

class ApplicationUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None
    workspace_id: Optional[str] = None

class ApplicationResponse(BaseModel):
    id: str
    tenant_id: str
    name: str
    description: Optional[str]
    is_active: bool
    # Source of application creation: 'manual' (UI/API) or 'auto_discovery' (gateway consumer)
    source: str = 'manual'
    # External identifier for auto-discovered apps (e.g., gateway consumer name)
    external_id: Optional[str] = None
    workspace_id: Optional[str] = None
    workspace_name: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    api_keys_count: int = 0
    protection_summary: Optional[Dict[str, Any]] = None

    class Config:
        from_attributes = True

class ApiKeyCreate(BaseModel):
    application_id: str
    name: Optional[str] = None

class ApiKeyResponse(BaseModel):
    id: str
    application_id: str
    key: str
    name: Optional[str]
    is_active: bool
    last_used_at: Optional[datetime]
    created_at: datetime

    class Config:
        from_attributes = True

def generate_api_key() -> str:
    """Generate unique API key"""
    import secrets
    import string
    prefix = 'sk-xxai-'
    alphabet = string.ascii_letters + string.digits
    random_part = ''.join(secrets.choice(alphabet) for _ in range(56))
    return prefix + random_part

def initialize_application_configs(db: Session, application_id: str, tenant_id: str):
    """
    Initialize default configurations for a new application

    This creates:
    - RiskTypeConfig (all risk types enabled by default)
    - DataSecurityEntityTypes (system entity types enabled)
    - ApplicationScannerConfig (scanner configurations for new scanner system)
    """
    try:
        # 1. Create RiskTypeConfig with all risk types enabled by default
        # Check if config already exists for this application_id
        existing_risk_config = db.query(RiskTypeConfig).filter(
            RiskTypeConfig.application_id == application_id
        ).first()
        
        if existing_risk_config:
            logger.info(f"RiskTypeConfig already exists for application {application_id}, skipping creation")
        else:
            risk_config = RiskTypeConfig(
                application_id=application_id,
                tenant_id=tenant_id,
                s1_enabled=True, s2_enabled=True, s3_enabled=True, s4_enabled=True,
                s5_enabled=True, s6_enabled=True, s7_enabled=True, s8_enabled=True,
                s9_enabled=True, s10_enabled=True, s11_enabled=True, s12_enabled=True,
                s13_enabled=True, s14_enabled=True, s15_enabled=True, s16_enabled=True,
                s17_enabled=True, s18_enabled=True, s19_enabled=True, s20_enabled=True,
                s21_enabled=True,
                low_sensitivity_threshold=0.95,
                medium_sensitivity_threshold=0.60,
                high_sensitivity_threshold=0.40,
                sensitivity_trigger_level="medium"
            )
            db.add(risk_config)
            logger.info(f"Created RiskTypeConfig for application {application_id}")

        # 2. Copy DataSecurityEntityTypes from system templates
        # Check if entity types already exist for this application
        existing_entity_types = db.query(DataSecurityEntityType).filter(
            DataSecurityEntityType.application_id == application_id
        ).count()
        
        if existing_entity_types > 0:
            logger.info(f"DataSecurityEntityTypes already exist for application {application_id} ({existing_entity_types} found), skipping creation")
        else:
            system_templates = db.query(DataSecurityEntityType).filter(
                DataSecurityEntityType.source_type == 'system_template',
                DataSecurityEntityType.application_id.is_(None)
            ).all()

            if system_templates:
                for template in system_templates:
                    # Copy system template to this application
                    copy = DataSecurityEntityType(
                        tenant_id=tenant_id,
                        application_id=application_id,
                        entity_type=template.entity_type,
                        entity_type_name=template.entity_type_name,
                        category=template.category,
                        recognition_method=template.recognition_method,
                        recognition_config=(template.recognition_config or {}).copy() if isinstance(template.recognition_config, dict) else {},
                        anonymization_method=template.anonymization_method,
                        anonymization_config=(template.anonymization_config or {}).copy() if isinstance(template.anonymization_config, dict) else {},
                        is_active=True,
                        is_global=False,
                        source_type='system_copy',
                        template_id=template.id
                    )
                    db.add(copy)
                logger.info(f"Created {len(system_templates)} DataSecurityEntityTypes for application {application_id}")
            else:
                logger.warning(f"No system templates found for DataSecurityEntityTypes")

        # 4. Initialize scanner configurations for the new scanner system
        scanner_service = ScannerConfigService(db)
        try:
            scanner_configs_count = scanner_service.initialize_default_configs(
                application_id=uuid.UUID(application_id),
                tenant_id=uuid.UUID(tenant_id)
            )
            logger.info(f"Initialized {scanner_configs_count} scanner configs for application {application_id}")
        except Exception as scanner_error:
            logger.error(f"Failed to initialize scanner configs for application {application_id}: {scanner_error}")
            # Continue with other configs - scanner system can be fixed later

        db.commit()
        logger.info(f"Successfully initialized all configurations for application {application_id}")

    except Exception as e:
        logger.error(f"Failed to initialize configurations for application {application_id}: {e}")
        db.rollback()
        
        # Check if this is a unique constraint violation on tenant_id
        error_str = str(e)
        if "ix_risk_type_config_user_id" in error_str or "tenant_id" in error_str.lower():
            raise ValueError(
                "Database constraint error: A unique constraint on tenant_id is preventing "
                "multiple applications. This indicates a migration issue. Please run migration 014 "
                "to fix this: '014_force_remove_tenant_id_unique_constraints.sql'"
            )
        raise

@router.get("", response_model=List[ApplicationResponse])
async def list_applications(
    request: Request,
    db: Session = Depends(get_admin_db),
    include_summary: bool = True
):
    """List all applications for current tenant with optional protection summary"""
    tenant_id = get_current_tenant_id(request)

    apps = db.query(Application).filter(
        Application.tenant_id == tenant_id
    ).all()

    # Count API keys for each app and get protection summary
    results = []
    for app in apps:
        key_count = db.query(ApiKey).filter(ApiKey.application_id == app.id).count()

        # Get protection configuration summary
        protection_summary = None
        if include_summary:
            ws_id = getattr(app, 'workspace_id', None)

            # Get risk type config from workspace
            risk_config = db.query(RiskTypeConfig).filter(
                RiskTypeConfig.workspace_id == ws_id
            ).first() if ws_id else None

            # Count active data security entity types from workspace
            data_security_count = db.query(DataSecurityEntityType).filter(
                DataSecurityEntityType.workspace_id == ws_id,
                DataSecurityEntityType.is_active == True
            ).count() if ws_id else 0

            # Count active blacklists from workspace
            blacklist_count = db.query(Blacklist).filter(
                Blacklist.workspace_id == ws_id,
                Blacklist.is_active == True
            ).count() if ws_id else 0

            # Count active whitelists from workspace
            whitelist_count = db.query(Whitelist).filter(
                Whitelist.workspace_id == ws_id,
                Whitelist.is_active == True
            ).count() if ws_id else 0

            # Count active knowledge bases (stays at application level)
            knowledge_base_count = db.query(KnowledgeBase).filter(
                KnowledgeBase.application_id == app.id,
                KnowledgeBase.is_active == True
            ).count()

            # Calculate enabled scanners count from workspace
            enabled_scanners_count = db.query(ApplicationScannerConfig).filter(
                ApplicationScannerConfig.workspace_id == ws_id,
                ApplicationScannerConfig.is_enabled == True
            ).count() if ws_id else 0

            # Count total available scanners for this workspace
            total_scanners_count = db.query(ApplicationScannerConfig).filter(
                ApplicationScannerConfig.workspace_id == ws_id
            ).count() if ws_id else 0

            protection_summary = {
                "risk_types_enabled": enabled_scanners_count,  # Renamed to scanners_enabled for clarity
                "total_risk_types": total_scanners_count,      # Renamed to total_scanners for clarity
                "sensitivity_level": risk_config.sensitivity_trigger_level if risk_config else "medium",
                "data_security_entities": data_security_count,
                "blacklist_count": blacklist_count,
                "whitelist_count": whitelist_count,
                "knowledge_base_count": knowledge_base_count
            }

        # Get workspace info
        ws_id = getattr(app, 'workspace_id', None)
        ws_name = None
        if ws_id:
            ws = db.query(Workspace).filter(Workspace.id == ws_id).first()
            ws_name = ws.name if ws else None

        app_dict = {
            "id": str(app.id),
            "tenant_id": str(app.tenant_id),
            "name": app.name,
            "description": app.description,
            "is_active": app.is_active,
            "source": getattr(app, 'source', 'manual') or 'manual',  # Default to 'manual' for backward compatibility
            "external_id": getattr(app, 'external_id', None),
            "workspace_id": str(ws_id) if ws_id else None,
            "workspace_name": ws_name,
            "created_at": app.created_at,
            "updated_at": app.updated_at,
            "api_keys_count": key_count,
            "protection_summary": protection_summary
        }
        results.append(ApplicationResponse(**app_dict))

    return results

@router.post("", response_model=ApplicationResponse)
async def create_application(
    data: ApplicationCreate,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Create new application with default configurations"""
    tenant_id = get_current_tenant_id(request)

    # Check if name already exists
    existing = db.query(Application).filter(
        Application.tenant_id == tenant_id,
        Application.name == data.name
    ).first()

    if existing:
        raise HTTPException(status_code=400, detail="Application name already exists")

    # Auto-assign to workspace: use specified workspace or global workspace
    workspace_id = getattr(data, 'workspace_id', None)
    if not workspace_id:
        from services.workspace_resolver import ensure_global_workspace
        workspace_id = ensure_global_workspace(db, tenant_id)

    # Create application (source='manual' for UI-created apps)
    app = Application(
        tenant_id=tenant_id,
        name=data.name,
        description=data.description,
        is_active=True,
        source='manual',
        workspace_id=workspace_id,
    )
    db.add(app)
    db.commit()
    db.refresh(app)
    logger.info(f"Created application {app.name} ({app.id}) in workspace {workspace_id}")

    await log_operation(
        db=db, request=request, action="create",
        resource_type="application", resource_id=str(app.id), resource_name=app.name,
    )

    return ApplicationResponse(
        id=str(app.id),
        tenant_id=str(app.tenant_id),
        name=app.name,
        description=app.description,
        is_active=app.is_active,
        source=getattr(app, 'source', 'manual') or 'manual',
        external_id=getattr(app, 'external_id', None),
        workspace_id=str(app.workspace_id) if getattr(app, 'workspace_id', None) else None,
        created_at=app.created_at,
        updated_at=app.updated_at,
        api_keys_count=0
    )

@router.put("/{app_id}", response_model=ApplicationResponse)
async def update_application(
    app_id: str,
    data: ApplicationUpdate,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Update application"""
    tenant_id = get_current_tenant_id(request)

    app = db.query(Application).filter(
        Application.id == app_id,
        Application.tenant_id == tenant_id
    ).first()

    if not app:
        raise HTTPException(status_code=404, detail="Application not found")

    old_data = {"name": app.name, "description": app.description, "is_active": app.is_active,
                "workspace_id": str(app.workspace_id) if app.workspace_id else None}

    if data.name is not None:
        app.name = data.name
    if data.description is not None:
        app.description = data.description
    if data.is_active is not None:
        app.is_active = data.is_active
    if data.workspace_id is not None:
        if data.workspace_id == "":
            # Move to global workspace (apps must always be in a workspace)
            from services.workspace_resolver import ensure_global_workspace
            global_ws_id = ensure_global_workspace(db, tenant_id)
            app.workspace_id = global_ws_id
        else:
            ws = db.query(Workspace).filter(
                Workspace.id == data.workspace_id,
                Workspace.tenant_id == tenant_id,
            ).first()
            if not ws:
                raise HTTPException(status_code=404, detail="Workspace not found")
            app.workspace_id = ws.id

    db.commit()
    db.refresh(app)

    new_data = {"name": app.name, "description": app.description, "is_active": app.is_active,
                "workspace_id": str(app.workspace_id) if app.workspace_id else None}
    changes = compute_changes(old_data, new_data)
    await log_operation(
        db=db, request=request, action="update",
        resource_type="application", resource_id=str(app.id), resource_name=app.name,
        changes=changes,
    )

    key_count = db.query(ApiKey).filter(ApiKey.application_id == app.id).count()

    ws_name = None
    if getattr(app, 'workspace_id', None):
        ws = db.query(Workspace).filter(Workspace.id == app.workspace_id).first()
        ws_name = ws.name if ws else None

    return ApplicationResponse(
        id=str(app.id),
        tenant_id=str(app.tenant_id),
        name=app.name,
        description=app.description,
        is_active=app.is_active,
        source=getattr(app, 'source', 'manual') or 'manual',
        external_id=getattr(app, 'external_id', None),
        workspace_id=str(app.workspace_id) if getattr(app, 'workspace_id', None) else None,
        workspace_name=ws_name,
        created_at=app.created_at,
        updated_at=app.updated_at,
        api_keys_count=key_count
    )

@router.delete("/{app_id}")
async def delete_application(
    app_id: str,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Delete application (and all its API keys and configs)"""
    tenant_id = get_current_tenant_id(request)

    app = db.query(Application).filter(
        Application.id == app_id,
        Application.tenant_id == tenant_id
    ).first()

    if not app:
        raise HTTPException(status_code=404, detail="Application not found")

    # Check if it's the last application
    app_count = db.query(Application).filter(
        Application.tenant_id == tenant_id
    ).count()

    if app_count <= 1:
        raise HTTPException(status_code=400, detail="Cannot delete the last application")

    app_name = app.name
    app_id_str = str(app.id)
    db.delete(app)
    db.commit()

    await log_operation(
        db=db, request=request, action="delete",
        resource_type="application", resource_id=app_id_str, resource_name=app_name,
    )

    return {"message": "Application deleted successfully"}

# API Key management
@router.get("/{app_id}/keys", response_model=List[ApiKeyResponse])
async def list_api_keys(
    app_id: str,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """List all API keys for an application"""
    tenant_id = get_current_tenant_id(request)

    # Verify application belongs to tenant
    app = db.query(Application).filter(
        Application.id == app_id,
        Application.tenant_id == tenant_id
    ).first()

    if not app:
        raise HTTPException(status_code=404, detail="Application not found")

    keys = db.query(ApiKey).filter(ApiKey.application_id == app_id).all()

    return [ApiKeyResponse(
        id=str(k.id),
        application_id=str(k.application_id),
        key=k.key,
        name=k.name,
        is_active=k.is_active,
        last_used_at=k.last_used_at,
        created_at=k.created_at
    ) for k in keys]

@router.post("/{app_id}/keys", response_model=ApiKeyResponse)
async def create_api_key(
    app_id: str,
    data: ApiKeyCreate,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Create new API key for application"""
    tenant_id = get_current_tenant_id(request)

    # Verify application belongs to tenant
    app = db.query(Application).filter(
        Application.id == app_id,
        Application.tenant_id == tenant_id
    ).first()

    if not app:
        raise HTTPException(status_code=404, detail="Application not found")

    # Generate unique key
    key_str = generate_api_key()
    while db.query(ApiKey).filter(ApiKey.key == key_str).first():
        key_str = generate_api_key()

    api_key = ApiKey(
        tenant_id=tenant_id,
        application_id=app_id,
        key=key_str,
        name=data.name,
        is_active=True
    )
    db.add(api_key)
    db.commit()
    db.refresh(api_key)

    await log_operation(
        db=db, request=request, action="create",
        resource_type="api_key", resource_id=str(api_key.id), resource_name=api_key.name or f"Key for {app.name}",
    )

    return ApiKeyResponse(
        id=str(api_key.id),
        application_id=str(api_key.application_id),
        key=api_key.key,
        name=api_key.name,
        is_active=api_key.is_active,
        last_used_at=api_key.last_used_at,
        created_at=api_key.created_at
    )

@router.delete("/{app_id}/keys/{key_id}")
async def delete_api_key(
    app_id: str,
    key_id: str,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Delete API key"""
    tenant_id = get_current_tenant_id(request)

    # Verify key belongs to tenant's application
    key = db.query(ApiKey).join(Application).filter(
        ApiKey.id == key_id,
        ApiKey.application_id == app_id,
        Application.tenant_id == tenant_id
    ).first()

    if not key:
        raise HTTPException(status_code=404, detail="API key not found")

    key_name = key.name or str(key.id)
    key_id_str = str(key.id)
    db.delete(key)
    db.commit()

    await log_operation(
        db=db, request=request, action="delete",
        resource_type="api_key", resource_id=key_id_str, resource_name=key_name,
    )

    return {"message": "API key deleted successfully"}

@router.put("/{app_id}/keys/{key_id}/toggle")
async def toggle_api_key(
    app_id: str,
    key_id: str,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Toggle API key active status"""
    tenant_id = get_current_tenant_id(request)

    key = db.query(ApiKey).join(Application).filter(
        ApiKey.id == key_id,
        ApiKey.application_id == app_id,
        Application.tenant_id == tenant_id
    ).first()

    if not key:
        raise HTTPException(status_code=404, detail="API key not found")

    old_active = key.is_active
    key.is_active = not key.is_active
    db.commit()

    await log_operation(
        db=db, request=request, action="update",
        resource_type="api_key", resource_id=str(key.id), resource_name=key.name or str(key.id),
        changes=compute_changes({"is_active": old_active}, {"is_active": key.is_active}),
    )

    return {"is_active": key.is_active}
