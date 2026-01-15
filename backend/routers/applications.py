"""Application Management Router - CRUD operations for applications and API keys"""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from database.connection import get_admin_db
from database.models import (
    Application, ApiKey, Tenant, RiskTypeConfig, BanPolicy,
    DataSecurityEntityType, ResponseTemplate, Blacklist, Whitelist, KnowledgeBase,
    ApplicationScannerConfig, Scanner
)
from services.scanner_config_service import ScannerConfigService
from typing import List, Optional, Dict, Any
from pydantic import BaseModel
from datetime import datetime
import uuid
from utils.logger import setup_logger

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
    - BanPolicy (disabled by default)
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

        # 2. Create BanPolicy (disabled by default)
        existing_ban_policy = db.query(BanPolicy).filter(
            BanPolicy.application_id == application_id
        ).first()
        
        if existing_ban_policy:
            logger.info(f"BanPolicy already exists for application {application_id}, skipping creation")
        else:
            ban_policy = BanPolicy(
                application_id=application_id,
                tenant_id=tenant_id,
                enabled=False,
                risk_level='high_risk',
                trigger_count=3,
                time_window_minutes=10,
                ban_duration_minutes=1440  # 24 hours
            )
            db.add(ban_policy)
            logger.info(f"Created BanPolicy for application {application_id}")

        # 3. Copy DataSecurityEntityTypes from system templates
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
            # Get risk type config
            risk_config = db.query(RiskTypeConfig).filter(
                RiskTypeConfig.application_id == app.id
            ).first()

            # Get ban policy
            ban_policy = db.query(BanPolicy).filter(
                BanPolicy.application_id == app.id
            ).first()

            # Count active data security entity types
            data_security_count = db.query(DataSecurityEntityType).filter(
                DataSecurityEntityType.application_id == app.id,
                DataSecurityEntityType.is_active == True
            ).count()

            # Count active blacklists
            blacklist_count = db.query(Blacklist).filter(
                Blacklist.application_id == app.id,
                Blacklist.is_active == True
            ).count()

            # Count active whitelists
            whitelist_count = db.query(Whitelist).filter(
                Whitelist.application_id == app.id,
                Whitelist.is_active == True
            ).count()

            # Count active knowledge bases
            knowledge_base_count = db.query(KnowledgeBase).filter(
                KnowledgeBase.application_id == app.id,
                KnowledgeBase.is_active == True
            ).count()

            # Calculate enabled scanners count (new scanner system)
            # Count all scanners that are enabled for this application
            enabled_scanners_count = db.query(ApplicationScannerConfig).filter(
                ApplicationScannerConfig.application_id == app.id,
                ApplicationScannerConfig.is_enabled == True
            ).count()

            # Count total available scanners for this application
            total_scanners_count = db.query(ApplicationScannerConfig).filter(
                ApplicationScannerConfig.application_id == app.id
            ).count()

            protection_summary = {
                "risk_types_enabled": enabled_scanners_count,  # Renamed to scanners_enabled for clarity
                "total_risk_types": total_scanners_count,      # Renamed to total_scanners for clarity
                "ban_policy_enabled": ban_policy.enabled if ban_policy else False,
                "sensitivity_level": risk_config.sensitivity_trigger_level if risk_config else "medium",
                "data_security_entities": data_security_count,
                "blacklist_count": blacklist_count,
                "whitelist_count": whitelist_count,
                "knowledge_base_count": knowledge_base_count
            }

        app_dict = {
            "id": str(app.id),
            "tenant_id": str(app.tenant_id),
            "name": app.name,
            "description": app.description,
            "is_active": app.is_active,
            "source": getattr(app, 'source', 'manual') or 'manual',  # Default to 'manual' for backward compatibility
            "external_id": getattr(app, 'external_id', None),
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

    # Create application (source='manual' for UI-created apps)
    app = Application(
        tenant_id=tenant_id,
        name=data.name,
        description=data.description,
        is_active=True,
        source='manual'
    )
    db.add(app)
    db.commit()
    db.refresh(app)

    # Initialize default configurations
    try:
        initialize_application_configs(db, str(app.id), tenant_id)
        logger.info(f"Created application {app.name} ({app.id}) with default configurations")
    except Exception as e:
        # If config initialization fails, rollback the application creation
        logger.error(f"Failed to initialize configs for application {app.id}: {e}")
        db.delete(app)
        db.commit()
        raise HTTPException(
            status_code=500,
            detail=f"Failed to initialize application configurations: {str(e)}"
        )

    return ApplicationResponse(
        id=str(app.id),
        tenant_id=str(app.tenant_id),
        name=app.name,
        description=app.description,
        is_active=app.is_active,
        source=getattr(app, 'source', 'manual') or 'manual',
        external_id=getattr(app, 'external_id', None),
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

    if data.name is not None:
        app.name = data.name
    if data.description is not None:
        app.description = data.description
    if data.is_active is not None:
        app.is_active = data.is_active

    db.commit()
    db.refresh(app)

    key_count = db.query(ApiKey).filter(ApiKey.application_id == app.id).count()

    return ApplicationResponse(
        id=str(app.id),
        tenant_id=str(app.tenant_id),
        name=app.name,
        description=app.description,
        is_active=app.is_active,
        source=getattr(app, 'source', 'manual') or 'manual',
        external_id=getattr(app, 'external_id', None),
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

    db.delete(app)
    db.commit()

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

    db.delete(key)
    db.commit()

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

    key.is_active = not key.is_active
    db.commit()

    return {"is_active": key.is_active}
