"""
Data security API routes - sensitive data detection and de-sensitization based on regular expressions
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from typing import List, Dict, Any, Optional
from sqlalchemy.orm import Session
from sqlalchemy import or_, and_
import uuid
import logging

from database.connection import get_db
from database.models import Tenant, DataSecurityEntityType, TenantEntityTypeDisable
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

def get_current_user(request: Request, db: Session = Depends(get_db)) -> Tenant:
    """Get current user"""
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context:
        raise HTTPException(status_code=401, detail="Unauthorized")

    tenant_id = auth_context.get("data", {}).get("tenant_id")
    if not tenant_id:
        raise HTTPException(status_code=401, detail="Invalid user ID")

    user = db.query(Tenant).filter(Tenant.id == uuid.UUID(tenant_id)).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    return user

@router.post("/entity-types", response_model=Dict[str, Any])
async def create_entity_type(
    entity_data: EntityTypeCreate,
    request: Request,
    db: Session = Depends(get_db)
):
    """Create sensitive data type configuration"""
    current_user = get_current_user(request, db)

    # Check if the entity type already exists for this tenant
    existing = db.query(DataSecurityEntityType).filter(
        and_(
            DataSecurityEntityType.entity_type == entity_data.entity_type,
            DataSecurityEntityType.tenant_id == current_user.id
        )
    ).first()

    if existing:
        raise HTTPException(status_code=400, detail="The entity type already exists for this tenant")

    # Create service instance
    service = DataSecurityService(db)

    # Create new configuration
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
        "created_at": entity_type.created_at.isoformat(),
        "updated_at": entity_type.updated_at.isoformat()
    }

@router.get("/entity-types")
async def list_entity_types(
    risk_level: Optional[str] = None,
    request: Request = None,
    db: Session = Depends(get_db)
) -> Dict[str, Any]:
    """Get sensitive data type configuration list (including global and user's own)"""
    current_user = get_current_user(request, db)

    # Create service instance
    service = DataSecurityService(db)

    # Get entity type list
    entity_types = service.get_entity_types(
        tenant_id=str(current_user.id),
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
    current_user = get_current_user(request, db)

    entity_type = db.query(DataSecurityEntityType).filter(
        DataSecurityEntityType.id == uuid.UUID(entity_type_id)
    ).first()

    if not entity_type:
        raise HTTPException(status_code=404, detail="Entity type configuration not found")

    # Check permission: only global configuration or user's own configuration
    if not entity_type.is_global and entity_type.tenant_id != current_user.id:
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
    current_user = get_current_user(request, db)

    entity_type = db.query(DataSecurityEntityType).filter(
        DataSecurityEntityType.id == uuid.UUID(entity_type_id)
    ).first()

    if not entity_type:
        raise HTTPException(status_code=404, detail="Entity type configuration not found")

    # Check permission
    if entity_type.is_global:
        # Only admin can modify global configuration
        if not current_user.is_super_admin:
            raise HTTPException(status_code=403, detail="Only admin can modify global configuration")
    elif entity_type.tenant_id != current_user.id:
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
    current_user = get_current_user(request, db)

    entity_type = db.query(DataSecurityEntityType).filter(
        DataSecurityEntityType.id == uuid.UUID(entity_type_id)
    ).first()

    if not entity_type:
        raise HTTPException(status_code=404, detail="Entity type configuration not found")

    # Check permission
    if entity_type.is_global:
        # Only admin can delete global configuration
        if not current_user.is_super_admin:
            raise HTTPException(status_code=403, detail="Only admin can delete global configuration")
    elif entity_type.tenant_id != current_user.id:
        raise HTTPException(status_code=403, detail="No permission to delete this configuration")

    # Create service instance
    service = DataSecurityService(db)

    # Delete
    success = service.delete_entity_type(entity_type_id, str(current_user.id))

    if not success:
        raise HTTPException(status_code=404, detail="Delete failed")

    return {"message": "Delete successfully"}

@router.post("/global-entity-types", response_model=Dict[str, Any])
async def create_global_entity_type(
    entity_data: EntityTypeCreate,
    request: Request,
    db: Session = Depends(get_db)
):
    """Create global sensitive data type configuration (only admin)"""
    current_user = get_current_user(request, db)

    # Check if the user is an admin
    if not current_user.is_super_admin:
        raise HTTPException(status_code=403, detail="Only admin can create global configuration")

    # Check if the global entity type already exists
    existing = db.query(DataSecurityEntityType).filter(
        and_(
            DataSecurityEntityType.entity_type == entity_data.entity_type,
            DataSecurityEntityType.is_global == True
        )
    ).first()

    if existing:
        raise HTTPException(status_code=400, detail="The global entity type already exists")

    # Create service instance
    service = DataSecurityService(db)

    # Create new global configuration
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
        is_global=True
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
        "created_at": entity_type.created_at.isoformat(),
        "updated_at": entity_type.updated_at.isoformat()
    }

@router.post("/entity-types/{entity_type}/disable")
async def disable_entity_type_for_tenant(
    entity_type: str,
    request: Request,
    db: Session = Depends(get_db)
):
    """Disable an entity type for the current tenant"""
    current_user = get_current_user(request, db)
    
    # Create service instance
    service = DataSecurityService(db)
    
    # Disable the entity type for this tenant
    success = service.disable_entity_type_for_tenant(str(current_user.id), entity_type)
    
    if not success:
        raise HTTPException(status_code=500, detail="Failed to disable entity type")
    
    return {"message": "Entity type disabled successfully"}

@router.post("/entity-types/{entity_type}/enable")
async def enable_entity_type_for_tenant(
    entity_type: str,
    request: Request,
    db: Session = Depends(get_db)
):
    """Enable an entity type for the current tenant"""
    current_user = get_current_user(request, db)
    
    # Create service instance
    service = DataSecurityService(db)
    
    # Enable the entity type for this tenant
    success = service.enable_entity_type_for_tenant(str(current_user.id), entity_type)
    
    if not success:
        raise HTTPException(status_code=500, detail="Failed to enable entity type")
    
    return {"message": "Entity type enabled successfully"}

@router.get("/disabled-entity-types")
async def get_disabled_entity_types(
    request: Request,
    db: Session = Depends(get_db)
) -> Dict[str, Any]:
    """Get list of disabled entity types for the current tenant"""
    current_user = get_current_user(request, db)
    
    # Create service instance
    service = DataSecurityService(db)
    
    # Get disabled entity types
    disabled_types = service.get_tenant_disabled_entity_types(str(current_user.id))
    
    return {
        "disabled_entity_types": disabled_types
    }