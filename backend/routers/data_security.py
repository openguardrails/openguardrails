"""
Data security API routes - sensitive data detection and de-sensitization based on regular expressions
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional, Tuple
from sqlalchemy.orm import Session
from sqlalchemy import or_, and_
import uuid
import logging

from database.connection import get_db
from database.models import Tenant, DataSecurityEntityType, TenantEntityTypeDisable, Application
from services.data_security_service import DataSecurityService
from utils.auth import verify_token

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/config/data-security", tags=["data-security"])

# Pydantic model definition
class EntityTypeCreate(BaseModel):
    """Create entity type configuration"""
    entity_type: str = Field(..., description="Entity type code, e.g. ID_CARD_NUMBER")
    display_name: str = Field(..., description="Display name, e.g. ID card number")
    risk_level: str = Field(..., description="Risk level: low, medium, high")
    pattern: str = Field(..., description="Regular expression pattern")
    anonymization_method: str = Field(default="replace", description="De-sensitization method: replace, mask, hash, encrypt, shuffle, random")
    anonymization_config: Optional[Dict[str, Any]] = Field(default=None, description="De-sensitization configuration")
    check_input: bool = Field(default=True, description="Whether to check input")
    check_output: bool = Field(default=True, description="Whether to check output")
    is_active: bool = Field(default=True, description="Whether to activate")

class EntityTypeUpdate(BaseModel):
    """Update entity type configuration"""
    display_name: Optional[str] = None
    risk_level: Optional[str] = None
    pattern: Optional[str] = None
    anonymization_method: Optional[str] = None
    anonymization_config: Optional[Dict[str, Any]] = None
    check_input: Optional[bool] = None
    check_output: Optional[bool] = None
    is_active: Optional[bool] = None

def get_current_user_and_application_from_request(request: Request, db: Session) -> Tuple[Tenant, uuid.UUID]:
    """
    Get current tenant and application_id from request
    Returns: (Tenant, application_id)
    """
    # 0) Check for X-Application-ID header (highest priority - from frontend selector)
    header_app_id = request.headers.get('x-application-id') or request.headers.get('X-Application-ID')
    if header_app_id:
        try:
            header_app_uuid = uuid.UUID(str(header_app_id))
            app = db.query(Application).filter(
                Application.id == header_app_uuid,
                Application.is_active == True
            ).first()
            if app:
                tenant = db.query(Tenant).filter(Tenant.id == app.tenant_id).first()
                if tenant:
                    return tenant, header_app_uuid
        except (ValueError, AttributeError):
            pass

    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context or 'data' not in auth_context:
        raise HTTPException(status_code=401, detail="Not authenticated")

    data = auth_context['data']

    # Extract application_id first (priority)
    application_id_value = data.get('application_id')
    if application_id_value:
        try:
            application_uuid = uuid.UUID(str(application_id_value))
            # Verify application exists and get its tenant
            app = db.query(Application).filter(Application.id == application_uuid, Application.is_active == True).first()
            if app:
                tenant = db.query(Tenant).filter(Tenant.id == app.tenant_id).first()
                if tenant:
                    return tenant, application_uuid
        except (ValueError, AttributeError):
            pass

    # Fallback: get tenant and use their default application
    tenant_id = data.get('tenant_id')
    if not tenant_id:
        raise HTTPException(status_code=401, detail="Tenant ID not found in auth context")

    try:
        tenant_uuid = uuid.UUID(str(tenant_id))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid tenant ID format")

    tenant = db.query(Tenant).filter(Tenant.id == tenant_uuid).first()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    # Get default application for this tenant
    default_app = db.query(Application).filter(
        Application.tenant_id == tenant.id,
        Application.is_active == True
    ).first()

    if not default_app:
        raise HTTPException(status_code=404, detail="No active application found for user")

    return tenant, default_app.id

@router.post("/entity-types", response_model=Dict[str, Any])
async def create_entity_type(
    entity_data: EntityTypeCreate,
    request: Request,
    db: Session = Depends(get_db)
):
    """Create sensitive data type configuration"""
    current_user, application_id = get_current_user_and_application_from_request(request, db)

    # Check if the entity type already exists for this application
    existing = db.query(DataSecurityEntityType).filter(
        and_(
            DataSecurityEntityType.entity_type == entity_data.entity_type,
            DataSecurityEntityType.application_id == application_id
        )
    ).first()

    if existing:
        raise HTTPException(status_code=400, detail="The entity type already exists for this application")

    # Create service instance
    service = DataSecurityService(db)

    # Create new configuration
    entity_type = service.create_entity_type(
        tenant_id=str(current_user.id),
        application_id=str(application_id),
        entity_type=entity_data.entity_type,
        display_name=entity_data.display_name,
        risk_level=entity_data.risk_level,
        pattern=entity_data.pattern,
        anonymization_method=entity_data.anonymization_method,
        anonymization_config=entity_data.anonymization_config,
        check_input=entity_data.check_input,
        check_output=entity_data.check_output,
        is_global=False
    )

    recognition_config = entity_type.recognition_config or {}

    return {
        "id": str(entity_type.id),
        "entity_type": entity_type.entity_type,
        "display_name": entity_type.display_name,
        "risk_level": entity_type.category,
        "pattern": recognition_config.get('pattern', ''),
        "anonymization_method": entity_type.anonymization_method,
        "anonymization_config": entity_type.anonymization_config,
        "check_input": recognition_config.get('check_input', True),
        "check_output": recognition_config.get('check_output', True),
        "is_active": entity_type.is_active,
        "is_global": entity_type.is_global,
        "source_type": entity_type.source_type if hasattr(entity_type, 'source_type') else 'custom',
        "template_id": str(entity_type.template_id) if hasattr(entity_type, 'template_id') and entity_type.template_id else None,
        "created_at": entity_type.created_at.isoformat(),
        "updated_at": entity_type.updated_at.isoformat()
    }

@router.get("/entity-types")
async def list_entity_types(
    risk_level: Optional[str] = None,
    request: Request = None,
    db: Session = Depends(get_db)
) -> Dict[str, Any]:
    """Get sensitive data type configuration list (including global and application's own)"""
    current_user, application_id = get_current_user_and_application_from_request(request, db)

    # Create service instance
    service = DataSecurityService(db)

    # Get entity type list
    entity_types = service.get_entity_types(
        tenant_id=str(current_user.id),
        application_id=str(application_id),
        risk_level=risk_level
    )

    items = []
    for et in entity_types:
        recognition_config = et.recognition_config or {}
        items.append({
            "id": str(et.id),
            "entity_type": et.entity_type,
            "display_name": et.display_name,
            "risk_level": et.category,
            "pattern": recognition_config.get('pattern', ''),
            "anonymization_method": et.anonymization_method,
            "anonymization_config": et.anonymization_config,
            "check_input": recognition_config.get('check_input', True),
            "check_output": recognition_config.get('check_output', True),
            "is_active": et.is_active,
            "is_global": et.is_global,
            "source_type": et.source_type if hasattr(et, 'source_type') else 'custom',
            "template_id": str(et.template_id) if hasattr(et, 'template_id') and et.template_id else None,
            "created_at": et.created_at.isoformat(),
            "updated_at": et.updated_at.isoformat()
        })

    return {
        "total": len(items),
        "items": items
    }

@router.get("/entity-types/{entity_type_id}")
async def get_entity_type(
    entity_type_id: str,
    request: Request,
    db: Session = Depends(get_db)
) -> Dict[str, Any]:
    """Get single sensitive data type configuration"""
    current_user, application_id = get_current_user_and_application_from_request(request, db)

    entity_type = db.query(DataSecurityEntityType).filter(
        DataSecurityEntityType.id == uuid.UUID(entity_type_id)
    ).first()

    if not entity_type:
        raise HTTPException(status_code=404, detail="Entity type configuration not found")

    # Check permission: only global configuration or application's own configuration
    if not entity_type.is_global and entity_type.application_id != application_id:
        raise HTTPException(status_code=403, detail="No permission to access this configuration")

    recognition_config = entity_type.recognition_config or {}

    return {
        "id": str(entity_type.id),
        "entity_type": entity_type.entity_type,
        "display_name": entity_type.display_name,
        "risk_level": entity_type.category,
        "pattern": recognition_config.get('pattern', ''),
        "anonymization_method": entity_type.anonymization_method,
        "anonymization_config": entity_type.anonymization_config,
        "check_input": recognition_config.get('check_input', True),
        "check_output": recognition_config.get('check_output', True),
        "is_active": entity_type.is_active,
        "is_global": entity_type.is_global,
        "source_type": entity_type.source_type if hasattr(entity_type, 'source_type') else 'custom',
        "template_id": str(entity_type.template_id) if hasattr(entity_type, 'template_id') and entity_type.template_id else None,
        "created_at": entity_type.created_at.isoformat(),
        "updated_at": entity_type.updated_at.isoformat()
    }

@router.put("/entity-types/{entity_type_id}")
async def update_entity_type(
    entity_type_id: str,
    update_data: EntityTypeUpdate,
    request: Request,
    db: Session = Depends(get_db)
) -> Dict[str, Any]:
    """Update sensitive data type configuration"""
    current_user, application_id = get_current_user_and_application_from_request(request, db)

    entity_type = db.query(DataSecurityEntityType).filter(
        DataSecurityEntityType.id == uuid.UUID(entity_type_id)
    ).first()

    if not entity_type:
        raise HTTPException(status_code=404, detail="Entity type configuration not found")

    # Check permission based on source_type
    if entity_type.source_type == 'system_template':
        # Only admin can modify system templates
        if not current_user.is_super_admin:
            raise HTTPException(status_code=403, detail="Only admin can modify system templates")
    elif entity_type.source_type == 'system_copy':
        # Application can modify their own system copy
        if entity_type.application_id != application_id:
            raise HTTPException(status_code=403, detail="No permission to modify this configuration")
    elif entity_type.source_type == 'custom':
        # Application can only modify their own custom configuration
        if entity_type.application_id != application_id:
            raise HTTPException(status_code=403, detail="No permission to modify this configuration")
    else:
        # Fallback to old logic for backward compatibility
        if entity_type.is_global:
            # Only admin can modify global configuration
            if not current_user.is_super_admin:
                raise HTTPException(status_code=403, detail="Only admin can modify global configuration")
        elif entity_type.application_id != application_id:
            raise HTTPException(status_code=403, detail="No permission to modify this configuration")

    # Create service instance
    service = DataSecurityService(db)

    # Build update parameters
    update_kwargs = {}
    if update_data.display_name is not None:
        update_kwargs['display_name'] = update_data.display_name
    if update_data.risk_level is not None:
        update_kwargs['risk_level'] = update_data.risk_level
    if update_data.pattern is not None:
        update_kwargs['pattern'] = update_data.pattern
    if update_data.anonymization_method is not None:
        update_kwargs['anonymization_method'] = update_data.anonymization_method
    if update_data.anonymization_config is not None:
        update_kwargs['anonymization_config'] = update_data.anonymization_config
    if update_data.check_input is not None:
        update_kwargs['check_input'] = update_data.check_input
    if update_data.check_output is not None:
        update_kwargs['check_output'] = update_data.check_output
    if update_data.is_active is not None:
        update_kwargs['is_active'] = update_data.is_active

    # Update
    updated_entity = service.update_entity_type(
        entity_type_id=entity_type_id,
        tenant_id=str(current_user.id),
        application_id=str(application_id),
        **update_kwargs
    )

    if not updated_entity:
        raise HTTPException(status_code=404, detail="Update failed")

    recognition_config = updated_entity.recognition_config or {}

    return {
        "id": str(updated_entity.id),
        "entity_type": updated_entity.entity_type,
        "display_name": updated_entity.display_name,
        "risk_level": updated_entity.category,
        "pattern": recognition_config.get('pattern', ''),
        "anonymization_method": updated_entity.anonymization_method,
        "anonymization_config": updated_entity.anonymization_config,
        "check_input": recognition_config.get('check_input', True),
        "check_output": recognition_config.get('check_output', True),
        "is_active": updated_entity.is_active,
        "is_global": updated_entity.is_global,
        "source_type": updated_entity.source_type if hasattr(updated_entity, 'source_type') else 'custom',
        "template_id": str(updated_entity.template_id) if hasattr(updated_entity, 'template_id') and updated_entity.template_id else None,
        "created_at": updated_entity.created_at.isoformat(),
        "updated_at": updated_entity.updated_at.isoformat()
    }

@router.delete("/entity-types/{entity_type_id}")
async def delete_entity_type(
    entity_type_id: str,
    request: Request,
    db: Session = Depends(get_db)
):
    """Delete sensitive data type configuration"""
    current_user, application_id = get_current_user_and_application_from_request(request, db)

    entity_type = db.query(DataSecurityEntityType).filter(
        DataSecurityEntityType.id == uuid.UUID(entity_type_id)
    ).first()

    if not entity_type:
        raise HTTPException(status_code=404, detail="Entity type configuration not found")

    # Check permission based on source_type
    if entity_type.source_type == 'system_template':
        # Only admin can delete system templates
        if not current_user.is_super_admin:
            raise HTTPException(status_code=403, detail="Only admin can delete system templates")
    elif entity_type.source_type == 'system_copy':
        # Application cannot delete system copies, but can disable them
        raise HTTPException(status_code=403, detail="Cannot delete system entity types. Please disable them instead.")
    elif entity_type.source_type == 'custom':
        # Application can only delete their own custom configuration
        if entity_type.application_id != application_id:
            raise HTTPException(status_code=403, detail="No permission to delete this configuration")
    else:
        # Fallback to old logic for backward compatibility
        if entity_type.is_global:
            # Only admin can delete global configuration
            if not current_user.is_super_admin:
                raise HTTPException(status_code=403, detail="Only admin can delete global configuration")
        elif entity_type.application_id != application_id:
            raise HTTPException(status_code=403, detail="No permission to delete this configuration")

    # Create service instance
    service = DataSecurityService(db)

    # Delete
    success = service.delete_entity_type(entity_type_id, str(current_user.id), str(application_id))

    if not success:
        raise HTTPException(status_code=404, detail="Delete failed")

    return {"message": "Delete successfully"}

@router.post("/global-entity-types", response_model=Dict[str, Any])
async def create_global_entity_type(
    entity_data: EntityTypeCreate,
    request: Request,
    db: Session = Depends(get_db)
):
    """Create system template entity type (only admin)

    This creates a template that will be automatically copied to all applications.
    Each application gets their own editable copy.
    """
    current_user, application_id = get_current_user_and_application_from_request(request, db)

    # Check if the user is an admin
    if not current_user.is_super_admin:
        raise HTTPException(status_code=403, detail="Only admin can create system templates")

    # Check if the system template already exists
    existing = db.query(DataSecurityEntityType).filter(
        and_(
            DataSecurityEntityType.entity_type == entity_data.entity_type,
            DataSecurityEntityType.source_type == 'system_template'
        )
    ).first()

    if existing:
        raise HTTPException(status_code=400, detail="The system template already exists")

    # Create service instance
    service = DataSecurityService(db)

    # Create new system template
    entity_type = service.create_entity_type(
        tenant_id=str(current_user.id),
        entity_type=entity_data.entity_type,
        display_name=entity_data.display_name,
        risk_level=entity_data.risk_level,
        pattern=entity_data.pattern,
        anonymization_method=entity_data.anonymization_method,
        anonymization_config=entity_data.anonymization_config,
        check_input=entity_data.check_input,
        check_output=entity_data.check_output,
        is_global=True,  # Keep for backward compatibility
        source_type='system_template'
    )

    recognition_config = entity_type.recognition_config or {}

    return {
        "id": str(entity_type.id),
        "entity_type": entity_type.entity_type,
        "display_name": entity_type.display_name,
        "risk_level": entity_type.category,
        "pattern": recognition_config.get('pattern', ''),
        "anonymization_method": entity_type.anonymization_method,
        "anonymization_config": entity_type.anonymization_config,
        "check_input": recognition_config.get('check_input', True),
        "check_output": recognition_config.get('check_output', True),
        "is_active": entity_type.is_active,
        "is_global": entity_type.is_global,
        "source_type": entity_type.source_type if hasattr(entity_type, 'source_type') else 'custom',
        "template_id": str(entity_type.template_id) if hasattr(entity_type, 'template_id') and entity_type.template_id else None,
        "created_at": entity_type.created_at.isoformat(),
        "updated_at": entity_type.updated_at.isoformat()
    }

@router.post("/entity-types/{entity_type}/disable")
async def disable_entity_type_for_application(
    entity_type: str,
    request: Request,
    db: Session = Depends(get_db)
):
    """Disable an entity type for the current application"""
    current_user, application_id = get_current_user_and_application_from_request(request, db)

    # Create service instance
    service = DataSecurityService(db)

    # Disable the entity type for this application
    success = service.disable_entity_type_for_application(str(current_user.id), str(application_id), entity_type)
    
    if not success:
        raise HTTPException(status_code=500, detail="Failed to disable entity type")
    
    return {"message": "Entity type disabled successfully"}

@router.post("/entity-types/{entity_type}/enable")
async def enable_entity_type_for_application(
    entity_type: str,
    request: Request,
    db: Session = Depends(get_db)
):
    """Enable an entity type for the current application"""
    current_user, application_id = get_current_user_and_application_from_request(request, db)

    # Create service instance
    service = DataSecurityService(db)

    # Enable the entity type for this application
    success = service.enable_entity_type_for_application(str(current_user.id), str(application_id), entity_type)
    
    if not success:
        raise HTTPException(status_code=500, detail="Failed to enable entity type")
    
    return {"message": "Entity type enabled successfully"}

@router.get("/disabled-entity-types")
async def get_disabled_entity_types(
    request: Request,
    db: Session = Depends(get_db)
) -> Dict[str, Any]:
    """Get list of disabled entity types for the current application"""
    current_user, application_id = get_current_user_and_application_from_request(request, db)

    # Create service instance
    service = DataSecurityService(db)

    # Get disabled entity types
    disabled_types = service.get_application_disabled_entity_types(str(current_user.id), str(application_id))
    
    return {
        "disabled_entity_types": disabled_types
    }