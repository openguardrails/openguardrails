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
from utils.subscription_check import (
    require_subscription_for_feature,
    SubscriptionFeature,
    get_feature_availability
)
from config import settings

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
                # GenAI code anonymization fields (for anonymization_method='genai_code')
                "genai_code_desc": et.restore_natural_desc,  # Natural language description for genai_code
                "genai_code": et.restore_code,  # Generated Python code for genai_code
                "has_genai_code": bool(et.restore_code),
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

    **Premium Features (SaaS mode only - requires subscription)**:
    - GenAI recognition method (`recognition_method='genai'`)
    - GenAI code anonymization (`anonymization_method='genai_code'`)
    - Natural language description for anonymization

    In enterprise/private deployment mode, all features are available.
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

        # Check subscription for premium features (SaaS mode only)
        # GenAI recognition requires subscription
        if recognition_method == "genai":
            require_subscription_for_feature(
                tenant_id=str(current_user.id),
                db=db,
                feature=SubscriptionFeature.GENAI_RECOGNITION,
                language=settings.default_language
            )

        # GenAI code anonymization requires subscription
        if anonymization_method == "genai_code":
            require_subscription_for_feature(
                tenant_id=str(current_user.id),
                db=db,
                feature=SubscriptionFeature.GENAI_CODE_ANONYMIZATION,
                language=settings.default_language
            )

        # Natural language description for anonymization requires subscription
        if data.get("genai_code_desc") or data.get("restore_natural_desc"):
            require_subscription_for_feature(
                tenant_id=str(current_user.id),
                db=db,
                feature=SubscriptionFeature.NATURAL_LANGUAGE_DESC,
                language=settings.default_language
            )

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
            source_type='custom',
            restore_natural_desc=data.get("genai_code_desc") or data.get("restore_natural_desc")  # Support both old and new field names
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

    **Premium Features (SaaS mode only - requires subscription)**:
    - GenAI recognition method (`recognition_method='genai'`)
    - GenAI code anonymization (`anonymization_method='genai_code'`)
    - Natural language description for anonymization

    In enterprise/private deployment mode, all features are available.
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

        # Check subscription for premium features (SaaS mode only)
        # GenAI recognition requires subscription
        if recognition_method == "genai":
            require_subscription_for_feature(
                tenant_id=str(current_user.id),
                db=db,
                feature=SubscriptionFeature.GENAI_RECOGNITION,
                language=settings.default_language
            )

        if recognition_method is not None:
            update_kwargs["recognition_method"] = recognition_method
        if "pattern" in data:
            update_kwargs["pattern"] = data["pattern"]
        if "entity_definition" in data:
            update_kwargs["entity_definition"] = data["entity_definition"]

        # 允许用户自定义脱敏方法，GenAI识别也可以使用任何脱敏方法
        if "anonymization_method" in data:
            update_kwargs["anonymization_method"] = data["anonymization_method"]
            # GenAI code anonymization requires subscription
            if data["anonymization_method"] == "genai_code":
                require_subscription_for_feature(
                    tenant_id=str(current_user.id),
                    db=db,
                    feature=SubscriptionFeature.GENAI_CODE_ANONYMIZATION,
                    language=settings.default_language
                )

        if "anonymization_config" in data:
            update_kwargs["anonymization_config"] = data["anonymization_config"]
        if "check_input" in data:
            update_kwargs["check_input"] = data["check_input"]
        if "check_output" in data:
            update_kwargs["check_output"] = data["check_output"]
        if "is_active" in data:
            update_kwargs["is_active"] = data["is_active"]

        # GenAI code anonymization fields (for anonymization_method='genai_code')
        if "genai_code_desc" in data:
            # Natural language description requires subscription
            require_subscription_for_feature(
                tenant_id=str(current_user.id),
                db=db,
                feature=SubscriptionFeature.NATURAL_LANGUAGE_DESC,
                language=settings.default_language
            )
            update_kwargs["restore_natural_desc"] = data["genai_code_desc"]
        elif "restore_natural_desc" in data:  # Support old field name for backwards compatibility
            require_subscription_for_feature(
                tenant_id=str(current_user.id),
                db=db,
                feature=SubscriptionFeature.NATURAL_LANGUAGE_DESC,
                language=settings.default_language
            )
            update_kwargs["restore_natural_desc"] = data["restore_natural_desc"]

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
    Generate anonymization regex using AI

    Input:
        {
            "description": "Keep first 3 and last 4 digits",
            "entity_type": "PHONE_NUMBER",
            "sample_data": "13812345678"  (optional)
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
    Test anonymization effect

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
    Generate entity type code using AI based on entity type name

    Input:
        {
            "entity_type_name": "Phone Number"
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
    Generate recognition regex using AI

    Input:
        {
            "description": "Chinese phone number",
            "entity_type": "PHONE_NUMBER",
            "sample_data": "13812345678"  (optional)
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
    Test recognition regex

    Input:
        {
            "pattern": "1[3-9]\\d{9}",
            "test_input": "My phone is 13812345678, please contact me"
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
    Test GenAI entity definition

    **Premium Feature (SaaS mode only - requires subscription)**:
    GenAI entity recognition testing requires a subscribed plan.
    In enterprise/private deployment mode, all features are available.

    Input:
        {
            "entity_definition": "11-digit phone number for contact",
            "entity_type_name": "手机号码",
            "test_input": "My phone is 13812345678, please contact me"
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

        # GenAI recognition testing requires subscription
        require_subscription_for_feature(
            tenant_id=str(current_user.id),
            db=db,
            feature=SubscriptionFeature.GENAI_RECOGNITION,
            language=settings.default_language
        )

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


# ============== GenAI Code Anonymization APIs ==============
# These endpoints configure the 'genai_code' anonymization method which uses
# AI-generated Python code to perform custom anonymization logic.

@router.post("/config/data-security/generate-genai-code")
async def generate_genai_code_standalone(
    data: dict,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    Generate Python code for genai_code anonymization method based on natural language description.

    **Premium Feature (SaaS mode only - requires subscription)**:
    GenAI code generation requires a subscribed plan.
    In enterprise/private deployment mode, all features are available.

    This is a standalone endpoint that doesn't require an existing entity type.
    The generated code can be tested immediately and saved later with the entity type.

    Input:
        {
            "natural_description": "Keep first 3 and last 4 characters, replace middle with asterisks",
            "sample_data": "1234567890"
        }

    Output:
        {
            "success": true,
            "code_generated": true,
            "genai_code": "def anonymize(text): ...",
            "message": "Code generated successfully"
        }
    """
    from services.restore_anonymization_service import get_restore_anonymization_service, CodeGenerationError

    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        # GenAI code anonymization requires subscription
        require_subscription_for_feature(
            tenant_id=str(current_user.id),
            db=db,
            feature=SubscriptionFeature.GENAI_CODE_ANONYMIZATION,
            language=settings.default_language
        )

        natural_description = data.get("natural_description", "")
        sample_data = data.get("sample_data", "")

        if not natural_description:
            raise HTTPException(status_code=400, detail="Natural language description is required")

        # Generate code without needing entity type
        service = get_restore_anonymization_service()
        result = await service.generate_genai_anonymization_code(
            natural_description=natural_description,
            sample_data=sample_data
        )

        logger.info(f"Generated genai code by user {current_user.email}")

        return {
            "success": True,
            "code_generated": True,
            "genai_code": result['code'],
            "message": "Code generated successfully"
        }

    except CodeGenerationError as e:
        logger.error(f"Code generation error: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Generate genai code error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to generate code: {str(e)}")


@router.post("/config/data-security/test-genai-code")
async def test_genai_code_standalone(
    data: dict,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    Test the provided genai_code anonymization with user-provided test input.

    **Premium Feature (SaaS mode only - requires subscription)**:
    GenAI code testing requires a subscribed plan.
    In enterprise/private deployment mode, all features are available.

    This is a standalone endpoint that tests the code directly without needing
    an existing entity type.

    Input:
        {
            "code": "def anonymize(text): return text[:3] + '***' + text[-4:]",
            "test_input": "1234567890"
        }

    Output:
        {
            "success": true,
            "anonymized_text": "123***7890",
            "processing_time_ms": 5.2
        }
    """
    from services.restore_anonymization_service import get_restore_anonymization_service
    import time

    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        # GenAI code anonymization requires subscription
        require_subscription_for_feature(
            tenant_id=str(current_user.id),
            db=db,
            feature=SubscriptionFeature.GENAI_CODE_ANONYMIZATION,
            language=settings.default_language
        )

        code = data.get("code", "")
        test_input = data.get("test_input", "")

        if not code:
            raise HTTPException(status_code=400, detail="Code is required")
        if not test_input:
            raise HTTPException(status_code=400, detail="Test input is required")

        start_time = time.time()

        # Test the code
        service = get_restore_anonymization_service()
        result = service.execute_genai_code(
            code=code,
            text=test_input
        )

        processing_time_ms = (time.time() - start_time) * 1000

        logger.info(f"Tested genai code by user {current_user.email}")

        return {
            "success": True,
            "anonymized_text": result,
            "processing_time_ms": processing_time_ms
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Test genai code error: {e}", exc_info=True)
        return {
            "success": False,
            "anonymized_text": "",
            "error": str(e),
            "processing_time_ms": 0
        }


@router.post("/config/data-security/entity-types/{entity_type_id}/generate-genai-code")
async def generate_genai_code(
    entity_type_id: str,
    data: dict,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    Generate Python code for genai_code anonymization method based on natural language description.

    **Premium Feature (SaaS mode only - requires subscription)**:
    GenAI code generation requires a subscribed plan.
    In enterprise/private deployment mode, all features are available.

    This is used when anonymization_method='genai_code' to generate custom anonymization logic.

    Input:
        {
            "natural_description": "Replace email addresses with placeholders, keep domain visible",
            "sample_data": "Contact alice@gmail.com for details"
        }

    Output:
        {
            "success": true,
            "placeholder_format": "__email_N__",
            "message": "Code generated successfully"
        }
    """
    from services.restore_anonymization_service import get_restore_anonymization_service, CodeGenerationError

    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        # GenAI code anonymization requires subscription
        require_subscription_for_feature(
            tenant_id=str(current_user.id),
            db=db,
            feature=SubscriptionFeature.GENAI_CODE_ANONYMIZATION,
            language=settings.default_language
        )

        natural_description = data.get("natural_description", "")
        sample_data = data.get("sample_data", "")

        if not natural_description:
            raise HTTPException(status_code=400, detail="Natural language description is required")

        # Get the entity type
        from database.models import DataSecurityEntityType
        entity_type = db.query(DataSecurityEntityType).filter(
            DataSecurityEntityType.id == entity_type_id
        ).first()

        if not entity_type:
            raise HTTPException(status_code=404, detail="Entity type not found")

        # Verify ownership
        if str(entity_type.tenant_id) != str(current_user.id) and not current_user.is_super_admin:
            raise HTTPException(status_code=403, detail="Access denied")

        # Generate restore code
        service = get_restore_anonymization_service()
        result = await service.generate_restore_code(
            entity_type_code=entity_type.entity_type,
            entity_type_name=entity_type.entity_type_name,
            natural_description=natural_description,
            sample_data=sample_data
        )

        # Update the entity type with generated code
        entity_type.restore_code = result['code']
        entity_type.restore_code_hash = result['code_hash']
        entity_type.restore_natural_desc = natural_description
        db.commit()

        logger.info(f"Generated restore code for entity type {entity_type_id} by user {current_user.email}")

        return {
            "success": True,
            "code_generated": True,
            "restore_code": result['code'],
            "placeholder_format": result['placeholder_format'],
            "message": "Code generated successfully"
        }

    except CodeGenerationError as e:
        logger.error(f"Code generation error: {e}")
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Generate restore code error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to generate restore code: {str(e)}")


@router.post("/config/data-security/entity-types/{entity_type_id}/test-genai-code")
async def test_genai_code(
    entity_type_id: str,
    data: dict,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    Test the generated genai_code anonymization with user-provided test input.

    **Premium Feature (SaaS mode only - requires subscription)**:
    GenAI code testing requires a subscribed plan.
    In enterprise/private deployment mode, all features are available.

    Input:
        {
            "test_input": "Contact alice@gmail.com and bob@company.com"
        }

    Output:
        {
            "success": true,
            "anonymized_text": "Contact __email_1__ and __email_2__",
            "mapping": {
                "__email_1__": "alice@gmail.com",
                "__email_2__": "bob@company.com"
            },
            "placeholder_count": 2
        }
    """
    from services.restore_anonymization_service import get_restore_anonymization_service

    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        # GenAI code anonymization requires subscription
        require_subscription_for_feature(
            tenant_id=str(current_user.id),
            db=db,
            feature=SubscriptionFeature.GENAI_CODE_ANONYMIZATION,
            language=settings.default_language
        )

        test_input = data.get("test_input", "")
        if not test_input:
            raise HTTPException(status_code=400, detail="Test input is required")

        # Get the entity type
        from database.models import DataSecurityEntityType
        entity_type = db.query(DataSecurityEntityType).filter(
            DataSecurityEntityType.id == entity_type_id
        ).first()

        if not entity_type:
            raise HTTPException(status_code=404, detail="Entity type not found")

        # Verify ownership
        if str(entity_type.tenant_id) != str(current_user.id) and not current_user.is_super_admin:
            raise HTTPException(status_code=403, detail="Access denied")

        # Check if restore code exists
        if not entity_type.restore_code:
            raise HTTPException(status_code=400, detail="Restore code not generated yet. Please generate code first.")

        # Test the restore anonymization
        service = get_restore_anonymization_service()
        result = service.test_restore_anonymization(
            text=test_input,
            entity_type_code=entity_type.entity_type,
            restore_code=entity_type.restore_code
        )

        logger.info(f"Tested restore anonymization for entity type {entity_type_id} by user {current_user.email}")

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Test restore anonymization error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to test restore anonymization: {str(e)}")


@router.put("/config/data-security/entity-types/{entity_type_id}/genai-code-config")
async def save_genai_code_config(
    entity_type_id: str,
    data: dict,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    Save the genai_code anonymization configuration.

    **Premium Feature (SaaS mode only - requires subscription)**:
    GenAI code configuration requires a subscribed plan.
    In enterprise/private deployment mode, all features are available.

    When anonymization_method='genai_code', use this endpoint to save the
    natural language description that was used to generate the code.

    Input:
        {
            "natural_description": "Replace email addresses with placeholders"
        }

    Output:
        {
            "success": true,
            "message": "GenAI code configuration saved"
        }
    """
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        # GenAI code anonymization requires subscription
        require_subscription_for_feature(
            tenant_id=str(current_user.id),
            db=db,
            feature=SubscriptionFeature.GENAI_CODE_ANONYMIZATION,
            language=settings.default_language
        )

        natural_description = data.get("natural_description", "")

        # Get the entity type
        from database.models import DataSecurityEntityType
        entity_type = db.query(DataSecurityEntityType).filter(
            DataSecurityEntityType.id == entity_type_id
        ).first()

        if not entity_type:
            raise HTTPException(status_code=404, detail="Entity type not found")

        # Verify ownership
        if str(entity_type.tenant_id) != str(current_user.id) and not current_user.is_super_admin:
            raise HTTPException(status_code=403, detail="Access denied")

        # Update natural description for genai_code method
        if natural_description:
            entity_type.restore_natural_desc = natural_description

        db.commit()

        logger.info(f"Saved genai-code config for entity type {entity_type_id} by user {current_user.email}")

        return {
            "success": True,
            "message": "GenAI code configuration saved"
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Save genai-code config error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to save genai-code config: {str(e)}")


# ============== Premium Feature Availability API ==============

@router.get("/config/data-security/feature-availability")
async def get_premium_feature_availability(
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    Get availability status for premium data security features.

    Returns whether the current user can access premium features like:
    - GenAI entity recognition
    - GenAI code-based anonymization
    - Natural language anonymization description
    - Auto format detection
    - Smart content segmentation

    In enterprise/private deployment mode, all features are enabled.
    In SaaS mode, requires a subscribed plan for premium features.

    Output:
        {
            "is_enterprise": bool,  // True if running in enterprise mode
            "is_subscribed": bool,  // True if user has subscription access
            "features": {
                "genai_recognition": bool,
                "genai_code_anonymization": bool,
                "natural_language_desc": bool,
                "format_detection": bool,
                "smart_segmentation": bool,
                "custom_scanners": bool
            }
        }
    """
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        availability = get_feature_availability(
            tenant_id=str(current_user.id),
            db=db
        )

        logger.debug(f"Feature availability check for user {current_user.email}: {availability}")

        return availability

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Get feature availability error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to get feature availability: {str(e)}")
