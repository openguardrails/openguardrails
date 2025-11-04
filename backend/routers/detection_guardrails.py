from fastapi import APIRouter, Depends, Request, HTTPException
from services.detection_guardrail_service import DetectionGuardrailService
from services.ban_policy_service import BanPolicyService
from utils.i18n import get_language_from_request
from models.requests import GuardrailRequest, InputGuardrailRequest, OutputGuardrailRequest, Message
from models.responses import GuardrailResponse
from utils.logger import setup_logger

logger = setup_logger()
router = APIRouter(tags=["Detection Guardrails"])

async def check_user_ban_status(tenant_id: str, user_id: str):
    """Check if the user is banned"""
    ban_record = await BanPolicyService.check_user_banned(tenant_id, user_id)
    if ban_record:
        raise HTTPException(
            status_code=403,
            detail={
                "error": "User is banned",
                "ban_until": ban_record['ban_until'].isoformat() if hasattr(ban_record['ban_until'], 'isoformat') else str(ban_record['ban_until']),
                "reason": ban_record['reason']
            }
        )

@router.post("/guardrails", response_model=GuardrailResponse)
async def check_guardrails(
    request_data: GuardrailRequest,
    request: Request
):
    """
    Guardrail detection API - detection service专用版本（只写日志，不写数据库）
    """
    try:
        # Get client information
        ip_address = request.client.host if request.client else None
        user_agent = request.headers.get("user-agent")

        # Get user context
        auth_context = getattr(request.state, 'auth_context', None)
        tenant_id = None
        application_id = None
        if auth_context:
            tenant_id = str(auth_context['data'].get('tenant_id'))
            application_id = auth_context['data'].get('application_id')  # Extract application_id from auth

        # Also check for X-Application-ID header (for frontend/online test)
        header_app_id = request.headers.get('x-application-id') or request.headers.get('X-Application-ID')
        if header_app_id:
            application_id = header_app_id
            logger.info(f"Using application_id from header: {application_id}")

        if not tenant_id:
            raise HTTPException(status_code=401, detail="User ID not found in auth context")

        # Get user ID
        user_id = None
        if request_data.extra_body:
            user_id = request_data.extra_body.get('xxai_app_user_id')

        # If there is no user_id, use tenant_id as fallback
        if not user_id:
            user_id = tenant_id

        # Check if the user is banned
        await check_user_ban_status(tenant_id, user_id)

        # Create detection service (no database connection)
        guardrail_service = DetectionGuardrailService()

        # Execute detection (only write log file)
        result = await guardrail_service.check_guardrails(
            request_data,
            ip_address=ip_address,
            user_agent=user_agent,
            tenant_id=tenant_id,
            application_id=application_id  # Pass application_id to service
        )

        # Check and apply ban policy
        logger.info(f"Checking ban policy: overall_risk_level={result.overall_risk_level}, user_id={user_id}, tenant_id={tenant_id}")
        if result.overall_risk_level in ['中风险', '高风险']:
            logger.info(f"Ban policy check triggered for user_id={user_id}, risk_level={result.overall_risk_level}")
            try:
                # Get language setting
                language = get_language_from_request(request, tenant_id)
                await BanPolicyService.check_and_apply_ban_policy(
                    tenant_id=tenant_id,
                    user_id=user_id,
                    risk_level=result.overall_risk_level,
                    detection_result_id=result.id,
                    language=language,
                    application_id=application_id
                )
                logger.info(f"Ban policy check completed for user_id={user_id}")
            except Exception as e:
                logger.error(f"Ban policy check failed for user_id={user_id}: {e}", exc_info=True)
        else:
            logger.info(f"Ban policy check skipped: risk_level={result.overall_risk_level}")

        logger.info(f"Detection completed: {result.id}, action: {result.suggest_action}")

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Detection API error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Detection service error")

@router.get("/guardrails/health")
async def health_check():
    """Detection service health check"""
    return {
        "status": "healthy",
        "service": "detection_guardrails",
        "timestamp": "2025-01-01T00:00:00Z"
    }

@router.get("/guardrails/models")
async def list_models():
    """List available models"""
    return {
        "object": "list",
        "data": [
            {
                "id": "OpenGuardrails-Text",
                "object": "model",
                "created": 1640995200,
                "owned_by": "openguardrails",
                "permission": [],
                "root": "OpenGuardrails-Text",
                "parent": None,
            }
        ]
    }

@router.post("/guardrails/input", response_model=GuardrailResponse)
async def check_input_guardrails(
    request_data: InputGuardrailRequest,
    request: Request
):
    """
    Input detection API - detection service special version (for dify/coze etc. agent platform plugins)
    """
    try:
        # Convert input to messages format
        messages = [Message(role="user", content=request_data.input)]
        
        # Construct standard GuardrailRequest
        guardrail_request = GuardrailRequest(
            model="OpenGuardrails-Text",
            messages=messages
        )
        
        # Get client information
        ip_address = request.client.host if request.client else None
        user_agent = request.headers.get("user-agent")
        
        # Get user context
        auth_context = getattr(request.state, 'auth_context', None)
        tenant_id = None
        if auth_context:
            tenant_id = str(auth_context['data'].get('tenant_id'))
        
        if not tenant_id:
            raise HTTPException(status_code=401, detail="User ID not found in auth context")
        
        # Create detection service (no database connection)
        guardrail_service = DetectionGuardrailService()
        
        # Execute detection (only write log file)
        result = await guardrail_service.check_guardrails(
            guardrail_request, 
            ip_address=ip_address,
            user_agent=user_agent,
            tenant_id=tenant_id
        )
        
        logger.info(f"Input detection completed: {result.id}, action: {result.suggest_action}")
        
        return result
        
    except Exception as e:
        logger.error(f"Input detection API error: {e}")
        raise HTTPException(status_code=500, detail="Detection service error")

@router.post("/guardrails/output", response_model=GuardrailResponse)
async def check_output_guardrails(
    request_data: OutputGuardrailRequest,
    request: Request
):
    """
    Output detection API - detection service special version (for dify/coze etc. agent platform plugins)
    """
    try:
        # Convert input output to messages format
        messages = [
            Message(role="user", content=request_data.input),
            Message(role="assistant", content=request_data.output)
        ]
        
        # Construct standard GuardrailRequest
        guardrail_request = GuardrailRequest(
            model="OpenGuardrails-Text",
            messages=messages
        )
        
        # Get client information
        ip_address = request.client.host if request.client else None
        user_agent = request.headers.get("user-agent")
        
        # Get user context
        auth_context = getattr(request.state, 'auth_context', None)
        tenant_id = None
        if auth_context:
            tenant_id = str(auth_context['data'].get('tenant_id'))
        
        if not tenant_id:
            raise HTTPException(status_code=401, detail="User ID not found in auth context")
        
        # Create detection service (no database connection)
        guardrail_service = DetectionGuardrailService()
        
        # Execute detection (only write log file)
        result = await guardrail_service.check_guardrails(
            guardrail_request, 
            ip_address=ip_address,
            user_agent=user_agent,
            tenant_id=tenant_id
        )
        
        logger.info(f"Output detection completed: {result.id}, action: {result.suggest_action}")
        
        return result
        
    except Exception as e:
        logger.error(f"Output detection API error: {e}")
        raise HTTPException(status_code=500, detail="Detection service error")