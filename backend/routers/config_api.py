from typing import List, Optional, Tuple
import uuid
from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, File, Form
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from sqlalchemy.orm import Session
from database.connection import get_db
from database.models import (
    Blacklist, Whitelist, ResponseTemplate, KnowledgeBase, Tenant,
    TenantKnowledgeBaseDisable, Application, Scanner, ScannerPackage, CustomScanner
)
from models.requests import BlacklistRequest, WhitelistRequest, ResponseTemplateRequest, KnowledgeBaseRequest
from models.responses import (
    BlacklistResponse, WhitelistResponse, ResponseTemplateResponse, ApiResponse,
    KnowledgeBaseResponse, KnowledgeBaseFileInfo, SimilarQuestionResult
)
from utils.logger import setup_logger
from utils.auth import verify_token
from config import settings
from services.keyword_cache import keyword_cache
from services.template_cache import template_cache
from services.enhanced_template_service import enhanced_template_service
from services.admin_service import admin_service
from services.knowledge_base_service import knowledge_base_service
from routers.proxy_management import get_current_user_from_request

logger = setup_logger()
router = APIRouter(tags=["Configuration"])
security = HTTPBearer()

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

    # 1) Check if there is a tenant switch session
    switch_token = request.headers.get('x-switch-session')
    if switch_token:
        switched_tenant = admin_service.get_switched_user(db, switch_token)
        if switched_tenant:
            # For switched sessions, use the default application
            default_app = db.query(Application).filter(
                Application.tenant_id == switched_tenant.id,
                Application.is_active == True
            ).first()
            if not default_app:
                raise HTTPException(status_code=404, detail="No active application found for switched user")
            return switched_tenant, default_app.id

    # 2) Get tenant and application from auth context
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
    tenant_id_value = data.get('tenant_id') or data.get('tenant_id')
    tenant_email_value = data.get('email')

    tenant = None

    # Try to find tenant by ID
    if tenant_id_value:
        try:
            tenant_uuid = uuid.UUID(str(tenant_id_value))
            tenant = db.query(Tenant).filter(Tenant.id == tenant_uuid).first()
        except ValueError:
            pass

    # Fall back to email
    if not tenant and tenant_email_value:
        tenant = db.query(Tenant).filter(Tenant.email == tenant_email_value).first()

    # Last resort: parse JWT
    if not tenant:
        auth_header = request.headers.get('authorization') or request.headers.get('Authorization')
        if auth_header and auth_header.startswith('Bearer '):
            token = auth_header.split(' ', 1)[1]
            try:
                payload = verify_token(token)
                raw_tenant_id = payload.get('tenant_id') or payload.get('tenant_id') or payload.get('sub')
                if raw_tenant_id:
                    try:
                        tenant_uuid = uuid.UUID(str(raw_tenant_id))
                        tenant = db.query(Tenant).filter(Tenant.id == tenant_uuid).first()
                    except ValueError:
                        pass
                if not tenant:
                    email_claim = payload.get('email') or payload.get('username')
                    if email_claim:
                        tenant = db.query(Tenant).filter(Tenant.email == email_claim).first()
            except Exception:
                pass

    if not tenant:
        raise HTTPException(status_code=401, detail="User not found or invalid context")

    # Get default application for this tenant
    default_app = db.query(Application).filter(
        Application.tenant_id == tenant.id,
        Application.is_active == True
    ).first()

    if not default_app:
        raise HTTPException(status_code=404, detail="No active application found for user")

    return tenant, default_app.id

# 黑名单管理
@router.get("/config/blacklist", response_model=List[BlacklistResponse])
async def get_blacklist(request: Request, db: Session = Depends(get_db)):
    """Get blacklist configuration"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        blacklists = db.query(Blacklist).filter(Blacklist.application_id == application_id).order_by(Blacklist.created_at.desc()).all()
        return [BlacklistResponse(
            id=bl.id,
            name=bl.name,
            keywords=bl.keywords or [],
            description=bl.description,
            is_active=bl.is_active,
            created_at=bl.created_at,
            updated_at=bl.updated_at
        ) for bl in blacklists]
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Get blacklist error: {e}")
        raise HTTPException(status_code=500, detail="Failed to get blacklist")

@router.post("/config/blacklist", response_model=ApiResponse)
async def create_blacklist(blacklist_request: BlacklistRequest, request: Request, db: Session = Depends(get_db)):
    """Create blacklist"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        blacklist = Blacklist(
            tenant_id=current_user.id,
            application_id=application_id,
            name=blacklist_request.name,
            keywords=blacklist_request.keywords,
            description=blacklist_request.description,
            is_active=blacklist_request.is_active
        )
        db.add(blacklist)
        db.commit()

        # Invalidate keyword cache immediately
        await keyword_cache.invalidate_cache()

        logger.info(f"Blacklist created: {blacklist_request.name} for user: {current_user.email}, app: {application_id}")
        return ApiResponse(success=True, message="Blacklist created successfully")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Create blacklist error: {e}")
        raise HTTPException(status_code=500, detail="Failed to create blacklist")

@router.put("/config/blacklist/{blacklist_id}", response_model=ApiResponse)
async def update_blacklist(blacklist_id: int, blacklist_request: BlacklistRequest, request: Request, db: Session = Depends(get_db)):
    """Update blacklist"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        blacklist = db.query(Blacklist).filter_by(id=blacklist_id, application_id=application_id).first()
        if not blacklist:
            raise HTTPException(status_code=404, detail="Blacklist not found")

        blacklist.name = blacklist_request.name
        blacklist.keywords = blacklist_request.keywords
        blacklist.description = blacklist_request.description
        blacklist.is_active = blacklist_request.is_active

        db.commit()

        # Invalidate keyword cache immediately
        await keyword_cache.invalidate_cache()

        logger.info(f"Blacklist updated: {blacklist_id} for user: {current_user.email}, app: {application_id}")
        return ApiResponse(success=True, message="Blacklist updated successfully")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Update blacklist error: {e}")
        raise HTTPException(status_code=500, detail="Failed to update blacklist")

@router.delete("/config/blacklist/{blacklist_id}", response_model=ApiResponse)
async def delete_blacklist(blacklist_id: int, request: Request, db: Session = Depends(get_db)):
    """Delete blacklist"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        blacklist = db.query(Blacklist).filter_by(id=blacklist_id, application_id=application_id).first()
        if not blacklist:
            raise HTTPException(status_code=404, detail="Blacklist not found")

        db.delete(blacklist)
        db.commit()

        # Invalidate keyword cache immediately
        await keyword_cache.invalidate_cache()

        logger.info(f"Blacklist deleted: {blacklist_id} for user: {current_user.email}, app: {application_id}")
        return ApiResponse(success=True, message="Blacklist deleted successfully")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Delete blacklist error: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete blacklist")

# 白名单管理
@router.get("/config/whitelist", response_model=List[WhitelistResponse])
async def get_whitelist(request: Request, db: Session = Depends(get_db)):
    """Get whitelist configuration"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        whitelists = db.query(Whitelist).filter(Whitelist.application_id == application_id).order_by(Whitelist.created_at.desc()).all()
        return [WhitelistResponse(
            id=wl.id,
            name=wl.name,
            keywords=wl.keywords or [],
            description=wl.description,
            is_active=wl.is_active,
            created_at=wl.created_at,
            updated_at=wl.updated_at
        ) for wl in whitelists]
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Get whitelist error: {e}")
        raise HTTPException(status_code=500, detail="Failed to get whitelist")

@router.post("/config/whitelist", response_model=ApiResponse)
async def create_whitelist(whitelist_request: WhitelistRequest, request: Request, db: Session = Depends(get_db)):
    """Create whitelist"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        whitelist = Whitelist(
            tenant_id=current_user.id,
            application_id=application_id,
            name=whitelist_request.name,
            keywords=whitelist_request.keywords,
            description=whitelist_request.description,
            is_active=whitelist_request.is_active
        )
        db.add(whitelist)
        db.commit()

        # Invalidate keyword cache immediately
        await keyword_cache.invalidate_cache()

        logger.info(f"Whitelist created: {whitelist_request.name} for user: {current_user.email}, app: {application_id}")
        return ApiResponse(success=True, message="Whitelist created successfully")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Create whitelist error: {e}")
        raise HTTPException(status_code=500, detail="Failed to create whitelist")

@router.put("/config/whitelist/{whitelist_id}", response_model=ApiResponse)
async def update_whitelist(whitelist_id: int, whitelist_request: WhitelistRequest, request: Request, db: Session = Depends(get_db)):
    """Update whitelist"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        whitelist = db.query(Whitelist).filter_by(id=whitelist_id, application_id=application_id).first()
        if not whitelist:
            raise HTTPException(status_code=404, detail="Whitelist not found")

        whitelist.name = whitelist_request.name
        whitelist.keywords = whitelist_request.keywords
        whitelist.description = whitelist_request.description
        whitelist.is_active = whitelist_request.is_active

        db.commit()

        # Invalidate keyword cache immediately
        await keyword_cache.invalidate_cache()

        logger.info(f"Whitelist updated: {whitelist_id} for user: {current_user.email}, app: {application_id}")
        return ApiResponse(success=True, message="Whitelist updated successfully")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Update whitelist error: {e}")
        raise HTTPException(status_code=500, detail="Failed to update whitelist")

@router.delete("/config/whitelist/{whitelist_id}", response_model=ApiResponse)
async def delete_whitelist(whitelist_id: int, request: Request, db: Session = Depends(get_db)):
    """Delete whitelist"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        whitelist = db.query(Whitelist).filter_by(id=whitelist_id, application_id=application_id).first()
        if not whitelist:
            raise HTTPException(status_code=404, detail="Whitelist not found")

        db.delete(whitelist)
        db.commit()

        # Invalidate keyword cache immediately
        await keyword_cache.invalidate_cache()

        logger.info(f"Whitelist deleted: {whitelist_id} for user: {current_user.email}, app: {application_id}")
        return ApiResponse(success=True, message="Whitelist deleted successfully")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Delete whitelist error: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete whitelist")

# Response template management
@router.get("/config/responses", response_model=List[ResponseTemplateResponse])
async def get_response_templates(
    request: Request,
    db: Session = Depends(get_db),
    scanner_type: Optional[str] = None,
    scanner_identifier: Optional[str] = None
):
    """Get response template configuration, optionally filtered by scanner type/identifier"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        # Query response templates (scanner_name now stored in table, no JOIN needed)
        query = db.query(ResponseTemplate).filter(
            ResponseTemplate.application_id == application_id,
            ResponseTemplate.is_active == True
        )

        # Apply filters if provided
        if scanner_type:
            query = query.filter(ResponseTemplate.scanner_type == scanner_type)
        if scanner_identifier:
            query = query.filter(ResponseTemplate.scanner_identifier == scanner_identifier)

        results = query.order_by(ResponseTemplate.created_at.desc()).all()

        return [ResponseTemplateResponse(
            id=rt.id,
            tenant_id=str(rt.tenant_id) if rt.tenant_id else None,
            application_id=str(rt.application_id) if rt.application_id else None,
            category=rt.category,
            scanner_type=rt.scanner_type,
            scanner_identifier=rt.scanner_identifier,
            scanner_name=rt.scanner_name,  # Now directly from table
            risk_level=rt.risk_level,
            template_content=rt.template_content,
            is_default=rt.is_default,
            is_active=rt.is_active,
            created_at=rt.created_at,
            updated_at=rt.updated_at
        ) for rt in results]
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Get response templates error: {e}")
        raise HTTPException(status_code=500, detail="Failed to get response templates")

@router.post("/config/responses", response_model=ApiResponse)
async def create_response_template(template_request: ResponseTemplateRequest, request: Request, db: Session = Depends(get_db)):
    """Create response template - supports all scanner types"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        template = ResponseTemplate(
            tenant_id=current_user.id,
            application_id=application_id,
            category=template_request.category,
            scanner_type=template_request.scanner_type,
            scanner_identifier=template_request.scanner_identifier,
            risk_level=template_request.risk_level,
            template_content=template_request.template_content,
            is_default=template_request.is_default,
            is_active=template_request.is_active
        )
        db.add(template)
        db.commit()

        # Invalidate template cache immediately
        await template_cache.invalidate_cache()
        await enhanced_template_service.invalidate_cache()

        # Log with appropriate identifier
        identifier = template_request.scanner_identifier or template_request.category
        logger.info(f"Response template created: {identifier} (type: {template_request.scanner_type}) for user: {current_user.email}, app: {application_id}")
        return ApiResponse(success=True, message="Response template created successfully")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Create response template error: {e}")
        raise HTTPException(status_code=500, detail="Failed to create response template")

@router.put("/config/responses/{template_id}", response_model=ApiResponse)
async def update_response_template(template_id: int, template_request: ResponseTemplateRequest, request: Request, db: Session = Depends(get_db)):
    """Update response template - supports all scanner types"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        template = db.query(ResponseTemplate).filter_by(id=template_id, application_id=application_id).first()
        if not template:
            raise HTTPException(status_code=404, detail="Response template not found")

        template.category = template_request.category
        template.scanner_type = template_request.scanner_type
        template.scanner_identifier = template_request.scanner_identifier
        template.risk_level = template_request.risk_level
        template.template_content = template_request.template_content
        template.is_default = template_request.is_default
        template.is_active = template_request.is_active

        db.commit()

        # Invalidate template cache immediately
        await template_cache.invalidate_cache()
        await enhanced_template_service.invalidate_cache()

        identifier = template_request.scanner_identifier or template_request.category
        logger.info(f"Response template updated: {template_id} ({identifier}) for user: {current_user.email}, app: {application_id}")
        return ApiResponse(success=True, message="Response template updated successfully")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Update response template error: {e}")
        raise HTTPException(status_code=500, detail="Failed to update response template")

@router.delete("/config/responses/{template_id}", response_model=ApiResponse)
async def delete_response_template(template_id: int, request: Request, db: Session = Depends(get_db)):
    """Delete response template"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        template = db.query(ResponseTemplate).filter_by(id=template_id, application_id=application_id).first()
        if not template:
            raise HTTPException(status_code=404, detail="Response template not found")

        db.delete(template)
        db.commit()

        # Invalidate template cache immediately
        await template_cache.invalidate_cache()
        await enhanced_template_service.invalidate_cache()

        logger.info(f"Response template deleted: {template_id} for user: {current_user.email}, app: {application_id}")
        return ApiResponse(success=True, message="Response template deleted successfully")
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Delete response template error: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete response template")

# System info
@router.get("/config/system-info")
async def get_system_info():
    """Get system info"""
    try:
        return {
            "support_email": settings.support_email if settings.support_email else None,
            "app_name": settings.app_name,
            "app_version": settings.app_version
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Get system info error: {e}")
        raise HTTPException(status_code=500, detail="Failed to get system info")

# Cache management
@router.get("/config/cache-info")
async def get_cache_info():
    """Get cache info"""
    try:
        keyword_cache_info = keyword_cache.get_cache_info()
        template_cache_info = template_cache.get_cache_info()
        enhanced_template_cache_info = enhanced_template_service.get_cache_info()
        return {
            "status": "success",
            "data": {
                "keyword_cache": keyword_cache_info,
                "template_cache": template_cache_info,
                "enhanced_template_cache": enhanced_template_cache_info
            }
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Get cache info error: {e}")
        raise HTTPException(status_code=500, detail="Failed to get cache info")

@router.post("/config/cache/refresh")
async def refresh_cache():
    """Manually refresh cache"""
    try:
        await keyword_cache.invalidate_cache()
        await template_cache.invalidate_cache()
        await enhanced_template_service.invalidate_cache()
        return {
            "status": "success",
            "message": "All caches refreshed successfully"
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Refresh cache error: {e}")
        raise HTTPException(status_code=500, detail="Failed to refresh cache")

# Knowledge base management
@router.get("/config/knowledge-bases", response_model=List[KnowledgeBaseResponse])
async def get_knowledge_bases(
    category: Optional[str] = None,
    request: Request = None,
    db: Session = Depends(get_db)
):
    """Get knowledge base list"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        # Query application's own knowledge base + global knowledge base
        query = db.query(KnowledgeBase).filter(
            (KnowledgeBase.application_id == application_id) | (KnowledgeBase.is_global == True)
        )

        if category:
            query = query.filter(KnowledgeBase.category == category)

        knowledge_bases = query.order_by(KnowledgeBase.created_at.desc()).all()

        # Get disabled global KB IDs for current user (still using tenant_id for global KB disable)
        disabled_kb_ids = set(
            disable.kb_id for disable in db.query(TenantKnowledgeBaseDisable).filter(
                TenantKnowledgeBaseDisable.tenant_id == current_user.id
            ).all()
        )

        # Return list with is_disabled_by_me flag
        return [KnowledgeBaseResponse(
            id=kb.id,
            category=kb.category,
            scanner_type=kb.scanner_type,
            scanner_identifier=kb.scanner_identifier,
            scanner_name=kb.scanner_name,  # Include scanner_name for display
            name=kb.name,
            description=kb.description,
            file_path=kb.file_path,
            vector_file_path=kb.vector_file_path,
            total_qa_pairs=kb.total_qa_pairs,
            similarity_threshold=kb.similarity_threshold,
            is_active=kb.is_active,
            is_global=kb.is_global,
            is_disabled_by_me=kb.id in disabled_kb_ids if kb.is_global else False,
            created_at=kb.created_at,
            updated_at=kb.updated_at
        ) for kb in knowledge_bases]

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Get knowledge bases error: {e}")
        raise HTTPException(status_code=500, detail="Failed to get knowledge bases")

@router.post("/config/knowledge-bases", response_model=ApiResponse)
async def create_knowledge_base(
    file: UploadFile = File(...),
    category: str = Form(None),  # Made optional - can be replaced by scanner_type + scanner_identifier
    scanner_type: str = Form(None),  # Scanner type: blacklist, whitelist, official_scanner, marketplace_scanner, custom_scanner
    scanner_identifier: str = Form(None),  # Scanner identifier: blacklist ID, scanner tag (S1, S100, etc.)
    name: str = Form(...),
    description: str = Form(""),
    similarity_threshold: float = Form(0.7),
    is_active: bool = Form(True),
    is_global: bool = Form(False),
    request: Request = None,
    db: Session = Depends(get_db)
):
    """Create knowledge base - supports all scanner types (official, blacklist, custom, marketplace)"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        # Debug info
        logger.info(f"Create knowledge base - category: {category}, scanner_type: {scanner_type}, scanner_identifier: {scanner_identifier}, name: {name}, description: {description}, similarity_threshold: {similarity_threshold}, is_active: {is_active}, is_global: {is_global}")
        logger.info(f"File info - filename: {file.filename}, content_type: {file.content_type}")

        # Validate parameters - must have either category OR (scanner_type + scanner_identifier)
        if not name:
            logger.error(f"Missing required parameter: name")
            raise HTTPException(status_code=400, detail="Name is required")

        # Determine scanner type and identifier
        if scanner_type and scanner_identifier:
            # New format: using scanner_type and scanner_identifier
            pass
        elif category:
            # Legacy format: using category (S1-S21)
            scanner_type = 'official_scanner'
            scanner_identifier = category
        else:
            raise HTTPException(status_code=400, detail="Either category OR (scanner_type + scanner_identifier) is required")

        # Validate similarity_threshold
        if similarity_threshold < 0 or similarity_threshold > 1:
            raise HTTPException(status_code=400, detail="similarity_threshold must be between 0 and 1")

        # Check global permission (only admin can set global knowledge base)
        if is_global and not current_user.is_super_admin:
            raise HTTPException(status_code=403, detail="Only administrators can create global knowledge bases")

        # Validate scanner_type
        valid_scanner_types = ['blacklist', 'whitelist', 'official_scanner', 'marketplace_scanner', 'custom_scanner']
        if scanner_type not in valid_scanner_types:
            raise HTTPException(status_code=400, detail=f"Invalid scanner_type. Must be one of: {', '.join(valid_scanner_types)}")

        # Validate scanner exists based on type
        if scanner_type == 'blacklist':
            # Validate blacklist exists
            blacklist = db.query(Blacklist).filter(
                Blacklist.application_id == application_id,
                Blacklist.name == scanner_identifier
            ).first()
            if not blacklist:
                raise HTTPException(status_code=404, detail=f"Blacklist '{scanner_identifier}' not found")
        elif scanner_type == 'whitelist':
            # Validate whitelist exists
            whitelist = db.query(Whitelist).filter(
                Whitelist.application_id == application_id,
                Whitelist.name == scanner_identifier
            ).first()
            if not whitelist:
                raise HTTPException(status_code=404, detail=f"Whitelist '{scanner_identifier}' not found")
        elif scanner_type == 'official_scanner':
            # Validate official scanner tag (S1-S21)
            scanner = db.query(Scanner).filter(Scanner.tag == scanner_identifier).first()
            if not scanner:
                raise HTTPException(status_code=404, detail=f"Official scanner '{scanner_identifier}' not found")
        elif scanner_type == 'marketplace_scanner':
            # Validate marketplace scanner exists
            scanner = db.query(Scanner).filter(Scanner.tag == scanner_identifier).first()
            if not scanner:
                raise HTTPException(status_code=404, detail=f"Marketplace scanner '{scanner_identifier}' not found")
        elif scanner_type == 'custom_scanner':
            # Validate custom scanner exists for this application
            custom_scanner = db.query(CustomScanner).join(Scanner).filter(
                CustomScanner.application_id == application_id,
                Scanner.tag == scanner_identifier
            ).first()
            if not custom_scanner:
                raise HTTPException(status_code=404, detail=f"Custom scanner '{scanner_identifier}' not found")

        # Check if there is already a knowledge base with the same name and scanner
        # For global KB, check globally
        if is_global:
            existing = db.query(KnowledgeBase).filter(
                KnowledgeBase.is_global == True,
                KnowledgeBase.scanner_type == scanner_type,
                KnowledgeBase.scanner_identifier == scanner_identifier,
                KnowledgeBase.name == name
            ).first()
        else:
            existing = db.query(KnowledgeBase).filter(
                KnowledgeBase.application_id == application_id,
                KnowledgeBase.scanner_type == scanner_type,
                KnowledgeBase.scanner_identifier == scanner_identifier,
                KnowledgeBase.name == name
            ).first()

        if existing:
            raise HTTPException(status_code=400, detail="Knowledge base with this name already exists for this scanner")

        # Read file content
        file_content = await file.read()

        # Parse JSONL file
        qa_pairs = knowledge_base_service.parse_jsonl_file(file_content)

        # Create database record
        # Note: Even global KBs need an application_id (the creating application)
        # The is_global flag controls whether it's accessible to all applications
        knowledge_base = KnowledgeBase(
            tenant_id=current_user.id,
            application_id=application_id,
            category=category,  # Keep for backward compatibility
            scanner_type=scanner_type,
            scanner_identifier=scanner_identifier,
            name=name,
            description=description,
            file_path="",  # Will be set below
            total_qa_pairs=len(qa_pairs),
            similarity_threshold=similarity_threshold,
            is_active=is_active,
            is_global=is_global
        )

        db.add(knowledge_base)
        db.flush()  # Get ID

        # Save original file
        file_path = knowledge_base_service.save_original_file(file_content, knowledge_base.id, file.filename)
        knowledge_base.file_path = file_path

        # Create vector index
        vector_file_path = knowledge_base_service.create_vector_index(qa_pairs, knowledge_base.id)
        knowledge_base.vector_file_path = vector_file_path

        db.commit()

        # Invalidate enhanced template cache immediately
        await enhanced_template_service.invalidate_cache()

        logger.info(f"Knowledge base created: {name} for scanner {scanner_type}:{scanner_identifier}, user: {current_user.email}, app: {application_id}, global: {is_global}")
        return ApiResponse(success=True, message="Knowledge base created successfully")

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Create knowledge base error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to create knowledge base: {str(e)}")

@router.get("/config/knowledge-bases/available-scanners", response_model=dict)
async def get_available_scanners_for_knowledge_base(
    request: Request = None,
    db: Session = Depends(get_db)
):
    """Get all available scanners for knowledge base creation (blacklists, official, custom, marketplace)"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        result = {
            "blacklists": [],
            "whitelists": [],
            "official_scanners": [],
            "marketplace_scanners": [],
            "custom_scanners": []
        }

        # Get blacklists
        blacklists = db.query(Blacklist).filter(
            Blacklist.application_id == application_id,
            Blacklist.is_active == True
        ).all()
        result["blacklists"] = [
            {"value": bl.name, "label": f"Blacklist - {bl.name}"}
            for bl in blacklists
        ]

        # Get whitelists
        whitelists = db.query(Whitelist).filter(
            Whitelist.application_id == application_id,
            Whitelist.is_active == True
        ).all()
        result["whitelists"] = [
            {"value": wl.name, "label": f"Whitelist - {wl.name}"}
            for wl in whitelists
        ]

        # Get official scanners (S1-S21) from scanners table
        # Join with scanner_packages to get only official scanners
        official_scanners = db.query(Scanner).join(
            ScannerPackage, Scanner.package_id == ScannerPackage.id
        ).filter(
            ScannerPackage.is_official == True,
            ScannerPackage.package_type == 'builtin'
        ).order_by(Scanner.tag).all()
        result["official_scanners"] = [
            {"value": s.tag, "label": f"{s.tag} - {s.name}"}
            for s in official_scanners
        ]

        # Get marketplace scanners (purchased packages)
        # This requires checking package_purchases table
        # For now, we'll just get all scanners from purchasable packages
        marketplace_scanners = db.query(Scanner).join(
            ScannerPackage, Scanner.package_id == ScannerPackage.id
        ).filter(
            ScannerPackage.package_type == 'purchasable'
        ).order_by(Scanner.tag).all()
        result["marketplace_scanners"] = [
            {"value": s.tag, "label": f"{s.tag} - {s.name}"}
            for s in marketplace_scanners
        ]

        # Get custom scanners for this application
        custom_scanners = db.query(Scanner).join(
            CustomScanner, CustomScanner.scanner_id == Scanner.id
        ).filter(
            CustomScanner.application_id == application_id
        ).order_by(Scanner.tag).all()
        result["custom_scanners"] = [
            {"value": s.tag, "label": f"{s.tag} - {s.name}"}
            for s in custom_scanners
        ]

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Get available scanners error: {e}")
        raise HTTPException(status_code=500, detail="Failed to get available scanners")

@router.put("/config/knowledge-bases/{kb_id}", response_model=ApiResponse)
async def update_knowledge_base(
    kb_id: int,
    kb_request: KnowledgeBaseRequest,
    request: Request = None,
    db: Session = Depends(get_db)
):
    """Update knowledge base (only basic information, not including file)"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        # Find knowledge base (application's own or global)
        knowledge_base = db.query(KnowledgeBase).filter(
            KnowledgeBase.id == kb_id
        ).first()

        if not knowledge_base:
            raise HTTPException(status_code=404, detail="Knowledge base not found")

        # Permission check: only edit application's own knowledge base, or admin can edit global knowledge base
        if knowledge_base.application_id != application_id and not (current_user.is_super_admin and knowledge_base.is_global):
            raise HTTPException(status_code=403, detail="Permission denied")

        # Check global permission (only admin can set global knowledge base)
        if kb_request.is_global and not current_user.is_super_admin:
            raise HTTPException(status_code=403, detail="Only administrators can set knowledge bases as global")

        # Check if there is another knowledge base with the same name
        if kb_request.is_global:
            existing = db.query(KnowledgeBase).filter(
                KnowledgeBase.is_global == True,
                KnowledgeBase.category == kb_request.category,
                KnowledgeBase.name == kb_request.name,
                KnowledgeBase.id != kb_id
            ).first()
        else:
            existing = db.query(KnowledgeBase).filter(
                KnowledgeBase.application_id == application_id,
                KnowledgeBase.category == kb_request.category,
                KnowledgeBase.name == kb_request.name,
                KnowledgeBase.id != kb_id
            ).first()

        if existing:
            raise HTTPException(status_code=400, detail="Knowledge base with this name already exists for this category")

        knowledge_base.category = kb_request.category
        knowledge_base.name = kb_request.name
        knowledge_base.description = kb_request.description
        knowledge_base.similarity_threshold = kb_request.similarity_threshold
        knowledge_base.is_active = kb_request.is_active
        knowledge_base.is_global = kb_request.is_global

        db.commit()

        # Invalidate enhanced template cache immediately
        await enhanced_template_service.invalidate_cache()

        logger.info(f"Knowledge base updated: {kb_id} for user: {current_user.email}")
        return ApiResponse(success=True, message="Knowledge base updated successfully")

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Update knowledge base error: {e}")
        raise HTTPException(status_code=500, detail="Failed to update knowledge base")

@router.delete("/config/knowledge-bases/{kb_id}", response_model=ApiResponse)
async def delete_knowledge_base(
    kb_id: int,
    request: Request = None,
    db: Session = Depends(get_db)
):
    """Delete knowledge base"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        # Find knowledge base (application's own or global)
        knowledge_base = db.query(KnowledgeBase).filter(
            KnowledgeBase.id == kb_id
        ).first()

        if not knowledge_base:
            raise HTTPException(status_code=404, detail="Knowledge base not found")

        # Permission check:
        # 1. Applications can delete their own knowledge bases
        # 2. Administrators can delete system-level (global) knowledge bases
        # 3. Regular users cannot delete system-level knowledge bases
        if knowledge_base.application_id != application_id:
            if not (current_user.is_super_admin and knowledge_base.is_global):
                raise HTTPException(
                    status_code=403,
                    detail="Permission denied. You can only delete your own knowledge bases, or administrators can delete system-level knowledge bases."
                )

        # Delete related files
        knowledge_base_service.delete_knowledge_base_files(kb_id)

        # Delete database record
        db.delete(knowledge_base)
        db.commit()

        # Invalidate enhanced template cache immediately
        await enhanced_template_service.invalidate_cache()

        logger.info(f"Knowledge base deleted: {kb_id} for user: {current_user.email}")
        return ApiResponse(success=True, message="Knowledge base deleted successfully")

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Delete knowledge base error: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete knowledge base")

@router.post("/config/knowledge-bases/{kb_id}/replace-file", response_model=ApiResponse)
async def replace_knowledge_base_file(
    kb_id: int,
    file: UploadFile = File(...),
    request: Request = None,
    db: Session = Depends(get_db)
):
    """Replace knowledge base file"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        knowledge_base = db.query(KnowledgeBase).filter(
            KnowledgeBase.id == kb_id,
            KnowledgeBase.application_id == application_id
        ).first()

        if not knowledge_base:
            raise HTTPException(status_code=404, detail="Knowledge base not found")

        # Validate file type (no longer strictly depend on file extension, depend on content validation)
        # if not file.filename.endswith('.jsonl'):
        #     raise HTTPException(status_code=400, detail="File must be a JSONL file")

        # Read file content
        file_content = await file.read()

        # Parse JSONL file
        qa_pairs = knowledge_base_service.parse_jsonl_file(file_content)

        # Delete old file
        knowledge_base_service.delete_knowledge_base_files(kb_id)

        # Save new original file
        file_path = knowledge_base_service.save_original_file(file_content, kb_id, file.filename)

        # Create new vector index
        vector_file_path = knowledge_base_service.create_vector_index(qa_pairs, kb_id)

        # Update database record
        knowledge_base.file_path = file_path
        knowledge_base.vector_file_path = vector_file_path
        knowledge_base.total_qa_pairs = len(qa_pairs)

        db.commit()

        # Invalidate enhanced template cache immediately
        await enhanced_template_service.invalidate_cache()

        logger.info(f"Knowledge base file replaced: {kb_id} for user: {current_user.email}")
        return ApiResponse(success=True, message="Knowledge base file replaced successfully")

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Replace knowledge base file error: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to replace knowledge base file: {str(e)}")

@router.get("/config/knowledge-bases/{kb_id}/info", response_model=KnowledgeBaseFileInfo)
async def get_knowledge_base_info(
    kb_id: int,
    request: Request = None,
    db: Session = Depends(get_db)
):
    """Get knowledge base file info"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        knowledge_base = db.query(KnowledgeBase).filter(
            KnowledgeBase.id == kb_id,
            ((KnowledgeBase.application_id == application_id) | (KnowledgeBase.is_global == True))
        ).first()

        if not knowledge_base:
            raise HTTPException(status_code=404, detail="Knowledge base not found")

        file_info = knowledge_base_service.get_file_info(kb_id)

        return KnowledgeBaseFileInfo(**file_info)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Get knowledge base info error: {e}")
        raise HTTPException(status_code=500, detail="Failed to get knowledge base info")

@router.post("/config/knowledge-bases/{kb_id}/search", response_model=List[SimilarQuestionResult])
async def search_similar_questions(
    kb_id: int,
    query: str,
    top_k: Optional[int] = 5,
    request: Request = None,
    db: Session = Depends(get_db)
):
    """Search similar questions"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        # Find knowledge base (application's own or global)
        knowledge_base = db.query(KnowledgeBase).filter(
            KnowledgeBase.id == kb_id,
            ((KnowledgeBase.application_id == application_id) | (KnowledgeBase.is_global == True)),
            KnowledgeBase.is_active == True
        ).first()

        if not knowledge_base:
            raise HTTPException(status_code=404, detail="Knowledge base not found or not active")

        if not query.strip():
            raise HTTPException(status_code=400, detail="Query cannot be empty")

        # Use KB's configured similarity threshold
        results = knowledge_base_service.search_similar_questions(
            query.strip(),
            kb_id,
            top_k,
            similarity_threshold=knowledge_base.similarity_threshold,
            db=db
        )

        return [SimilarQuestionResult(**result) for result in results]

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Search similar questions error: {e}")
        raise HTTPException(status_code=500, detail="Failed to search similar questions")

@router.get("/config/categories/{category}/knowledge-bases", response_model=List[KnowledgeBaseResponse])
async def get_knowledge_bases_by_category(
    category: str,
    request: Request = None,
    db: Session = Depends(get_db)
):
    """Get knowledge base list by category"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        if category not in ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12']:
            raise HTTPException(status_code=400, detail="Invalid category")

        # Query application's own knowledge base + global knowledge base
        knowledge_bases = db.query(KnowledgeBase).filter(
            ((KnowledgeBase.application_id == application_id) | (KnowledgeBase.is_global == True)),
            KnowledgeBase.category == category,
            KnowledgeBase.is_active == True
        ).order_by(KnowledgeBase.created_at.desc()).all()

        return [KnowledgeBaseResponse(
            id=kb.id,
            category=kb.category,
            name=kb.name,
            description=kb.description,
            file_path=kb.file_path,
            vector_file_path=kb.vector_file_path,
            total_qa_pairs=kb.total_qa_pairs,
            similarity_threshold=kb.similarity_threshold,
            is_active=kb.is_active,
            is_global=kb.is_global,
            created_at=kb.created_at,
            updated_at=kb.updated_at
        ) for kb in knowledge_bases]

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Get knowledge bases by category error: {e}")
        raise HTTPException(status_code=500, detail="Failed to get knowledge bases by category")

@router.post("/config/knowledge-bases/{kb_id}/toggle-disable", response_model=ApiResponse)
async def toggle_global_knowledge_base_disable(
    kb_id: int,
    request: Request = None,
    db: Session = Depends(get_db)
):
    """
    Toggle global knowledge base disable status for current tenant
    Only affects global knowledge bases - tenant can disable them for their own use
    """
    try:
        current_user = get_current_user_from_request(request, db)

        # Find knowledge base
        knowledge_base = db.query(KnowledgeBase).filter(
            KnowledgeBase.id == kb_id
        ).first()

        if not knowledge_base:
            raise HTTPException(status_code=404, detail="Knowledge base not found")

        # Only global knowledge bases can be toggled by non-admin users
        # User's own knowledge bases should be managed via update API
        if not knowledge_base.is_global:
            raise HTTPException(status_code=400, detail="Only global knowledge bases can be toggled via this endpoint. Use update API for your own knowledge bases.")

        # Check if already disabled
        existing_disable = db.query(TenantKnowledgeBaseDisable).filter(
            TenantKnowledgeBaseDisable.tenant_id == current_user.id,
            TenantKnowledgeBaseDisable.kb_id == kb_id
        ).first()

        if existing_disable:
            # Re-enable: delete the disable record
            db.delete(existing_disable)
            db.commit()

            # Invalidate enhanced template cache immediately
            await enhanced_template_service.invalidate_cache()

            logger.info(f"Global knowledge base {kb_id} re-enabled for tenant: {current_user.email}")
            return ApiResponse(success=True, message="Global knowledge base enabled successfully")
        else:
            # Disable: create a disable record
            disable_record = TenantKnowledgeBaseDisable(
                tenant_id=current_user.id,
                kb_id=kb_id
            )
            db.add(disable_record)
            db.commit()

            # Invalidate enhanced template cache immediately
            await enhanced_template_service.invalidate_cache()

            logger.info(f"Global knowledge base {kb_id} disabled for tenant: {current_user.email}")
            return ApiResponse(success=True, message="Global knowledge base disabled successfully")

    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Toggle global knowledge base disable error: {e}")
        raise HTTPException(status_code=500, detail="Failed to toggle global knowledge base disable status")

@router.get("/config/knowledge-bases/{kb_id}/is-disabled", response_model=dict)
async def check_global_knowledge_base_disabled(
    kb_id: int,
    request: Request = None,
    db: Session = Depends(get_db)
):
    """Check if a global knowledge base is disabled for current tenant"""
    try:
        current_user = get_current_user_from_request(request, db)

        # Find knowledge base
        knowledge_base = db.query(KnowledgeBase).filter(
            KnowledgeBase.id == kb_id
        ).first()

        if not knowledge_base:
            raise HTTPException(status_code=404, detail="Knowledge base not found")

        # Check if disabled
        is_disabled = db.query(TenantKnowledgeBaseDisable).filter(
            TenantKnowledgeBaseDisable.tenant_id == current_user.id,
            TenantKnowledgeBaseDisable.kb_id == kb_id
        ).first() is not None

        return {
            "kb_id": kb_id,
            "is_global": knowledge_base.is_global,
            "is_disabled": is_disabled
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Check global knowledge base disabled error: {e}")
        raise HTTPException(status_code=500, detail="Failed to check knowledge base disabled status")