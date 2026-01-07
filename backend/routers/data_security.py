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
            entity_definition = recognition_config.get('entity_definition', '')
            check_input = recognition_config.get('check_input', True)
            check_output = recognition_config.get('check_output', True)

            items.append({
                "id": str(et.id),
                "entity_type": et.entity_type,
                "entity_type_name": et.entity_type_name,
                "category": et.category,  # This is the risk_level
                "recognition_method": et.recognition_method,
                "pattern": pattern,
                "entity_definition": entity_definition,
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
        entity_definition = recognition_config.get('entity_definition', '')
        check_input = recognition_config.get('check_input', True)
        check_output = recognition_config.get('check_output', True)

        return {
            "id": str(entity_type.id),
            "entity_type": entity_type.entity_type,
            "entity_type_name": entity_type.entity_type_name,
            "category": entity_type.category,
            "recognition_method": entity_type.recognition_method,
            "pattern": pattern,
            "entity_definition": entity_definition,
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

        recognition_method = data.get("recognition_method", "regex")

        # Auto-detect genai type: if entity_definition is provided but recognition_method is regex, fix it
        if data.get("entity_definition") and not data.get("pattern"):
            recognition_method = "genai"
            logger.info(f"Auto-corrected recognition_method to 'genai' based on entity_definition presence")

        # 允许用户自定义脱敏方法，GenAI识别也可以使用任何脱敏方法
        anonymization_method = data.get("anonymization_method", "mask")

        service = DataSecurityService(db)
        entity_type = service.create_entity_type(
            tenant_id=str(current_user.id),
            application_id=str(application_id),
            entity_type=data.get("entity_type"),
            entity_type_name=data.get("entity_type_name"),
            risk_level=data.get("category", "medium"),  # category is risk_level in the service
            recognition_method=recognition_method,
            pattern=data.get("pattern"),
            entity_definition=data.get("entity_definition"),
            anonymization_method=anonymization_method,
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
        if "entity_type_name" in data:
            update_kwargs["entity_type_name"] = data["entity_type_name"]
        if "category" in data:
            update_kwargs["risk_level"] = data["category"]  # category is risk_level in the service

        # Auto-detect genai type: if entity_definition is provided but recognition_method is regex, fix it
        recognition_method = data.get("recognition_method")
        if data.get("entity_definition") and not data.get("pattern"):
            recognition_method = "genai"
            logger.info(f"Auto-corrected recognition_method to 'genai' based on entity_definition presence")

        if recognition_method is not None:
            update_kwargs["recognition_method"] = recognition_method
        if "pattern" in data:
            update_kwargs["pattern"] = data["pattern"]
        if "entity_definition" in data:
            update_kwargs["entity_definition"] = data["entity_definition"]

        # 允许用户自定义脱敏方法，GenAI识别也可以使用任何脱敏方法
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

        recognition_method = data.get("recognition_method", "regex")

        # Auto-detect genai type: if entity_definition is provided but recognition_method is regex, fix it
        if data.get("entity_definition") and not data.get("pattern"):
            recognition_method = "genai"
            logger.info(f"Auto-corrected recognition_method to 'genai' based on entity_definition presence")

        # 允许用户自定义脱敏方法，GenAI识别也可以使用任何脱敏方法
        anonymization_method = data.get("anonymization_method", "mask")

        service = DataSecurityService(db)
        entity_type = service.create_entity_type(
            tenant_id=str(current_user.id),
            application_id=None,  # Global entity types don't have application_id
            entity_type=data.get("entity_type"),
            entity_type_name=data.get("entity_type_name"),
            risk_level=data.get("category", "medium"),
            recognition_method=recognition_method,
            pattern=data.get("pattern"),
            entity_definition=data.get("entity_definition"),
            anonymization_method=anonymization_method,
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


@router.post("/config/data-security/generate-anonymization-regex")
async def generate_anonymization_regex(
    data: dict,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    使用AI生成脱敏正则表达式

    Input:
        {
            "description": "保留前3位和后4位",
            "entity_type": "PHONE_NUMBER",
            "sample_data": "13812345678"  (可选)
        }

    Output:
        {
            "success": true,
            "regex_pattern": "(\\d{3})\\d{4}(\\d{4})",
            "replacement_template": "\\1****\\2",
            "explanation": "Pattern captures first 3 and last 4 digits"
        }
    """
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        description = data.get("description", "")
        entity_type = data.get("entity_type", "")
        sample_data = data.get("sample_data")

        if not description:
            raise HTTPException(status_code=400, detail="Description is required")

        service = DataSecurityService(db)
        result = await service.generate_anonymization_regex(
            description=description,
            entity_type=entity_type,
            sample_data=sample_data
        )

        logger.info(f"Generated anonymization regex for user: {current_user.email}, entity_type: {entity_type}")

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Generate anonymization regex error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to generate anonymization regex: {str(e)}")


@router.post("/config/data-security/test-anonymization")
async def test_anonymization(
    data: dict,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    测试脱敏效果

    Input:
        {
            "method": "regex_replace",
            "config": {
                "regex_pattern": "(\\d{3})\\d{4}(\\d{4})",
                "replacement_template": "\\1****\\2"
            },
            "test_input": "13812345678"
        }

    Output:
        {
            "success": true,
            "result": "138****5678",
            "processing_time_ms": 0.5
        }
    """
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        method = data.get("method", "")
        config = data.get("config", {})
        test_input = data.get("test_input", "")

        if not method:
            raise HTTPException(status_code=400, detail="Method is required")
        if not test_input:
            raise HTTPException(status_code=400, detail="Test input is required")

        service = DataSecurityService(db)
        result = service.test_anonymization(
            method=method,
            config=config,
            test_input=test_input
        )

        logger.info(f"Tested anonymization for user: {current_user.email}, method: {method}")

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Test anonymization error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to test anonymization: {str(e)}")


@router.post("/config/data-security/generate-entity-type-code")
async def generate_entity_type_code(
    data: dict,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    使用AI根据实体类型名称生成实体类型代码

    Input:
        {
            "entity_type_name": "手机号码"
        }

    Output:
        {
            "success": true,
            "entity_type_code": "PHONE_NUMBER"
        }
    """
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        entity_type_name = data.get("entity_type_name", "")

        if not entity_type_name:
            raise HTTPException(status_code=400, detail="Entity type name is required")

        service = DataSecurityService(db)
        result = await service.generate_entity_type_code(
            entity_type_name=entity_type_name
        )

        logger.info(f"Generated entity type code for user: {current_user.email}, name: {entity_type_name}")

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Generate entity type code error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to generate entity type code: {str(e)}")


@router.post("/config/data-security/generate-recognition-regex")
async def generate_recognition_regex(
    data: dict,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    使用AI生成识别正则表达式

    Input:
        {
            "description": "中国手机号码",
            "entity_type": "PHONE_NUMBER",
            "sample_data": "13812345678"  (可选)
        }

    Output:
        {
            "success": true,
            "regex_pattern": "1[3-9]\\d{9}",
            "explanation": "Pattern matches Chinese mobile phone numbers starting with 1 followed by 3-9 and 9 more digits"
        }
    """
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        description = data.get("description", "")
        entity_type = data.get("entity_type", "")
        sample_data = data.get("sample_data")

        if not description:
            raise HTTPException(status_code=400, detail="Description is required")

        service = DataSecurityService(db)
        result = await service.generate_recognition_regex(
            description=description,
            entity_type=entity_type,
            sample_data=sample_data
        )

        logger.info(f"Generated recognition regex for user: {current_user.email}, entity_type: {entity_type}")

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Generate recognition regex error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to generate recognition regex: {str(e)}")


@router.post("/config/data-security/test-recognition-regex")
async def test_recognition_regex(
    data: dict,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    测试识别正则表达式

    Input:
        {
            "pattern": "1[3-9]\\d{9}",
            "test_input": "我的电话是13812345678，请联系我"
        }

    Output:
        {
            "success": true,
            "matched": true,
            "matches": ["13812345678"],
            "match_count": 1,
            "processing_time_ms": 0.5
        }
    """
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        pattern = data.get("pattern", "")
        test_input = data.get("test_input", "")

        if not pattern:
            raise HTTPException(status_code=400, detail="Pattern is required")
        if not test_input:
            raise HTTPException(status_code=400, detail="Test input is required")

        service = DataSecurityService(db)
        result = service.test_recognition_regex(
            pattern=pattern,
            test_input=test_input
        )

        logger.info(f"Tested recognition regex for user: {current_user.email}")

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Test recognition regex error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to test recognition regex: {str(e)}")


@router.post("/config/data-security/test-entity-definition")
async def test_entity_definition(
    data: dict,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    测试GenAI实体定义

    Input:
        {
            "entity_definition": "用于联系的11位手机号码",
            "entity_type_name": "手机号码",
            "test_input": "我的电话是13812345678，请联系我"
        }

    Output:
        {
            "success": true,
            "matched": true,
            "matches": ["13812345678"],
            "match_count": 1,
            "processing_time_ms": 500.5
        }
    """
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        entity_definition = data.get("entity_definition", "")
        entity_type_name = data.get("entity_type_name", "")
        test_input = data.get("test_input", "")

        if not entity_definition:
            raise HTTPException(status_code=400, detail="Entity definition is required")
        if not test_input:
            raise HTTPException(status_code=400, detail="Test input is required")

        service = DataSecurityService(db)
        result = await service.test_entity_definition(
            entity_definition=entity_definition,
            entity_type_name=entity_type_name,
            test_input=test_input
        )

        logger.info(f"Tested entity definition for user: {current_user.email}")

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Test entity definition error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to test entity definition: {str(e)}")
