"""
Data Security Entity Types API Router
"""
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from database.connection import get_admin_db
from services.data_security_service import DataSecurityService
from routers.config_api import get_current_user_and_application_from_request
from utils.logger import setup_logger

logger = setup_logger()
router = APIRouter(tags=["Data Security"])


@router.get("/config/data-security/entity-types")
async def get_entity_types(
    request: Request,
    risk_level: Optional[str] = None,
    is_active: Optional[bool] = None,
    db: Session = Depends(get_admin_db)
):
    """
    Get sensitive data entity types list
    """
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        
        service = DataSecurityService(db)
        entity_types = service.get_entity_types(
            tenant_id=str(current_user.id),
            application_id=str(application_id),
            risk_level=risk_level,
            is_active=is_active
        )
        
        # Convert to response format
        items = []
        for et in entity_types:
            # Extract pattern and check flags from recognition_config
            recognition_config = et.recognition_config or {}
            pattern = recognition_config.get('pattern', '')
            check_input = recognition_config.get('check_input', True)
            check_output = recognition_config.get('check_output', True)
            
            items.append({
                "id": str(et.id),
                "entity_type": et.entity_type,
                "display_name": et.display_name,
                "category": et.category,  # This is the risk_level
                "pattern": pattern,
                "anonymization_method": et.anonymization_method,
                "anonymization_config": et.anonymization_config,
                "check_input": check_input,
                "check_output": check_output,
                "is_active": et.is_active,
                "source_type": et.source_type,
                "is_system_template": (et.source_type == 'system_template'),
                "created_at": et.created_at.isoformat() if et.created_at else None,
                "updated_at": et.updated_at.isoformat() if et.updated_at else None
            })
        
        return {"items": items, "total": len(items)}
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Get entity types error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get entity types: {str(e)}")


@router.get("/config/data-security/entity-types/{entity_type_id}")
async def get_entity_type(
    entity_type_id: str,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    Get single entity type detail
    """
    try:
        from database.models import DataSecurityEntityType
        from sqlalchemy import and_
        import uuid
        
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        
        # Query entity type - allow access if it belongs to the application or is a global template
        try:
            entity_type_uuid = uuid.UUID(entity_type_id)
        except (ValueError, AttributeError):
            raise HTTPException(status_code=400, detail="Invalid entity type ID format")
        
        conditions = [DataSecurityEntityType.id == entity_type_uuid]
        conditions.append(
            (DataSecurityEntityType.application_id == application_id) |
            (DataSecurityEntityType.source_type == 'system_template')
        )
        
        entity_type = db.query(DataSecurityEntityType).filter(and_(*conditions)).first()
        
        if not entity_type:
            raise HTTPException(status_code=404, detail="Entity type not found")
        
        # Extract pattern and check flags from recognition_config
        recognition_config = entity_type.recognition_config or {}
        pattern = recognition_config.get('pattern', '')
        check_input = recognition_config.get('check_input', True)
        check_output = recognition_config.get('check_output', True)
        
        return {
            "id": str(entity_type.id),
            "entity_type": entity_type.entity_type,
            "display_name": entity_type.display_name,
            "category": entity_type.category,
            "pattern": pattern,
            "anonymization_method": entity_type.anonymization_method,
            "anonymization_config": entity_type.anonymization_config,
            "check_input": check_input,
            "check_output": check_output,
            "is_active": entity_type.is_active,
            "source_type": entity_type.source_type,
            "is_system_template": (entity_type.source_type == 'system_template'),
            "created_at": entity_type.created_at.isoformat() if entity_type.created_at else None,
            "updated_at": entity_type.updated_at.isoformat() if entity_type.updated_at else None
        }
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Get entity type error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get entity type: {str(e)}")


@router.post("/config/data-security/entity-types")
async def create_entity_type(
    data: dict,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    Create custom entity type
    """
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        
        service = DataSecurityService(db)
        entity_type = service.create_entity_type(
            tenant_id=str(current_user.id),
            application_id=str(application_id),
            entity_type=data.get("entity_type"),
            display_name=data.get("display_name"),
            risk_level=data.get("category", "medium"),  # category is risk_level in the service
            pattern=data.get("pattern"),
            anonymization_method=data.get("anonymization_method", "mask"),
            anonymization_config=data.get("anonymization_config"),
            check_input=data.get("check_input", True),
            check_output=data.get("check_output", True),
            is_global=False,
            source_type='custom'
        )
        
        logger.info(f"Entity type created: {data.get('entity_type')} for user: {current_user.email}, app: {application_id}")
        
        return {
            "success": True,
            "message": "Entity type created successfully",
            "id": str(entity_type.id)
        }
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Create entity type error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to create entity type: {str(e)}")


@router.put("/config/data-security/entity-types/{entity_type_id}")
async def update_entity_type(
    entity_type_id: str,
    data: dict,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    Update entity type
    """
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        
        service = DataSecurityService(db)
        
        # Build update kwargs
        update_kwargs = {}
        if "display_name" in data:
            update_kwargs["display_name"] = data["display_name"]
        if "category" in data:
            update_kwargs["risk_level"] = data["category"]  # category is risk_level in the service
        if "pattern" in data:
            update_kwargs["pattern"] = data["pattern"]
        if "anonymization_method" in data:
            update_kwargs["anonymization_method"] = data["anonymization_method"]
        if "anonymization_config" in data:
            update_kwargs["anonymization_config"] = data["anonymization_config"]
        if "check_input" in data:
            update_kwargs["check_input"] = data["check_input"]
        if "check_output" in data:
            update_kwargs["check_output"] = data["check_output"]
        if "is_active" in data:
            update_kwargs["is_active"] = data["is_active"]
        
        result = service.update_entity_type(
            entity_type_id=entity_type_id,
            tenant_id=str(current_user.id),
            application_id=str(application_id),
            **update_kwargs
        )
        
        if not result:
            raise HTTPException(status_code=404, detail="Entity type not found or update failed")
        
        logger.info(f"Entity type updated: {entity_type_id} for user: {current_user.email}, app: {application_id}")
        
        return {
            "success": True,
            "message": "Entity type updated successfully"
        }
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Update entity type error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to update entity type: {str(e)}")


@router.delete("/config/data-security/entity-types/{entity_type_id}")
async def delete_entity_type(
    entity_type_id: str,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    Delete entity type
    """
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        
        service = DataSecurityService(db)
        success = service.delete_entity_type(
            entity_type_id=entity_type_id,
            tenant_id=str(current_user.id),
            application_id=str(application_id)
        )
        
        if not success:
            raise HTTPException(status_code=404, detail="Entity type not found or delete failed")
        
        logger.info(f"Entity type deleted: {entity_type_id} for user: {current_user.email}, app: {application_id}")
        
        return {
            "success": True,
            "message": "Entity type deleted successfully"
        }
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Delete entity type error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to delete entity type: {str(e)}")


@router.post("/config/data-security/global-entity-types")
async def create_global_entity_type(
    data: dict,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    Create global entity type (admin only)
    """
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        
        # Check admin permission
        if not current_user.is_super_admin:
            raise HTTPException(status_code=403, detail="Only administrators can create global entity types")
        
        service = DataSecurityService(db)
        entity_type = service.create_entity_type(
            tenant_id=str(current_user.id),
            application_id=None,  # Global entity types don't have application_id
            entity_type=data.get("entity_type"),
            display_name=data.get("display_name"),
            risk_level=data.get("category", "medium"),
            pattern=data.get("pattern"),
            anonymization_method=data.get("anonymization_method", "mask"),
            anonymization_config=data.get("anonymization_config"),
            check_input=data.get("check_input", True),
            check_output=data.get("check_output", True),
            is_global=True,
            source_type='system_template'
        )
        
        logger.info(f"Global entity type created: {data.get('entity_type')} by admin: {current_user.email}")
        
        return {
            "success": True,
            "message": "Global entity type created successfully",
            "id": str(entity_type.id)
        }
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Create global entity type error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to create global entity type: {str(e)}")
