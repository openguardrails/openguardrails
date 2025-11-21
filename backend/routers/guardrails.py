from fastapi import APIRouter, Depends, Request, HTTPException
from sqlalchemy.orm import Session
from database.connection import get_proxy_db
from services.guardrail_service import GuardrailService
from services.ban_policy_service import BanPolicyService
from utils.i18n import get_language_from_request
from models.requests import GuardrailRequest, InputGuardrailRequest, OutputGuardrailRequest, Message
from models.responses import GuardrailResponse
from utils.logger import setup_logger

logger = setup_logger()
router = APIRouter(tags=["Guardrails"])


async def check_user_ban_status(tenant_id: str, user_id: str):
    """Check if the user is banned, if banned, throw an exception"""
    if not user_id:
        return None

    ban_record = await BanPolicyService.check_user_banned(tenant_id, user_id)
    if ban_record:
        ban_until = ban_record['ban_until'].isoformat() if ban_record['ban_until'] else ''
        raise HTTPException(
            status_code=403,
            detail={
                "error": "User is banned",
                "user_id": user_id,
                "ban_until": ban_until,
                "reason": ban_record.get('reason', 'Trigger ban policy')
            }
        )
    return None

@router.post("/guardrails", response_model=GuardrailResponse)
async def check_guardrails(
    request_data: GuardrailRequest,
    request: Request,
    db: Session = Depends(get_proxy_db)
):
    """
    Guardrail detection API - compatible with OpenAI format

    Check if the input content exists security risks or compliance issues.
    """
    try:
        # Get client information
        ip_address = request.client.host if request.client else None
        user_agent = request.headers.get("user-agent")

        # Get tenant context
        auth_context = getattr(request.state, 'auth_context', None)
        tenant_id = None
        application_id = None
        if auth_context:
            tenant_id = str(auth_context['data'].get('tenant_id') or auth_context['data'].get('tenant_id'))
            application_id = auth_context['data'].get('application_id')

        if not tenant_id:
            raise HTTPException(status_code=401, detail="Tenant ID not found in auth context")

        # Get user ID
        user_id = None
        if request_data.extra_body:
            user_id = request_data.extra_body.get('xxai_app_user_id')

        # If there is no user_id, use tenant_id as fallback
        if not user_id:
            user_id = tenant_id

        # Check if the user is banned
        await check_user_ban_status(tenant_id, user_id)

        # Create guardrail service
        guardrail_service = GuardrailService(db)

        # Execute detection (pass tenant_id and application_id)
        result = await guardrail_service.check_guardrails(
            request_data,
            ip_address=ip_address,
            user_agent=user_agent,
            tenant_id=tenant_id,
            application_id=application_id
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
                    language=language
                )
                logger.info(f"Ban policy check completed for user_id={user_id}")
            except Exception as e:
                logger.error(f"Ban policy check failed for user_id={user_id}: {e}", exc_info=True)
        else:
            logger.info(f"Ban policy check skipped: risk_level={result.overall_risk_level}")

        logger.info(f"Guardrail check completed: {result.id}, action: {result.suggest_action}, user_id: {user_id}")

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Guardrail API error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")

@router.get("/guardrails/health")
async def health_check():
    """Guardrail service health check"""
    return {
        "status": "healthy",
        "service": "guardrails",
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
    request: Request,
    db: Session = Depends(get_proxy_db)
):
    """
    Input detection API - compatible with dify/coze etc. agent platform plugins

    Check if the input content exists security risks or compliance issues.
    Convert input to messages format for detection.
    """
    try:
        # Convert input to messages format
        messages = [Message(role="user", content=request_data.input)]

        # Construct standard GuardrailRequest
        guardrail_request = GuardrailRequest(
            model=request_data.model,
            messages=messages
        )

        # Get client information
        ip_address = request.client.host if request.client else None
        user_agent = request.headers.get("user-agent")

        # Get tenant context
        auth_context = getattr(request.state, 'auth_context', None)
        tenant_id = None
        if auth_context:
            tenant_id = str(auth_context['data'].get('tenant_id') or auth_context['data'].get('tenant_id'))

        if not tenant_id:
            raise HTTPException(status_code=401, detail="Tenant ID not found in auth context")

        # Get user ID
        user_id = request_data.xxai_app_user_id if request_data.xxai_app_user_id else tenant_id

        # Check if the user is banned
        await check_user_ban_status(tenant_id, user_id)

        # Create guardrail service
        guardrail_service = GuardrailService(db)

        # Execute detection
        result = await guardrail_service.check_guardrails(
            guardrail_request,
            ip_address=ip_address,
            user_agent=user_agent,
            tenant_id=tenant_id
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
                    language=language
                )
                logger.info(f"Ban policy check completed for user_id={user_id}")
            except Exception as e:
                logger.error(f"Ban policy check failed for user_id={user_id}: {e}", exc_info=True)
        else:
            logger.info(f"Ban policy check skipped: risk_level={result.overall_risk_level}")

        logger.info(f"Input guardrail check completed: {result.id}, action: {result.suggest_action}, user_id: {user_id}")

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Input guardrail API error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")

@router.post("/guardrails/output", response_model=GuardrailResponse)
async def check_output_guardrails(
    request_data: OutputGuardrailRequest,
    request: Request,
    db: Session = Depends(get_proxy_db)
):
    """
    Output detection API - compatible with dify/coze etc. agent platform plugins

    Check if the input and output content exists security risks or compliance issues.
    Convert input output to messages format for detection.
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

        # Get tenant context
        auth_context = getattr(request.state, 'auth_context', None)
        tenant_id = None
        if auth_context:
            tenant_id = str(auth_context['data'].get('tenant_id') or auth_context['data'].get('tenant_id'))

        if not tenant_id:
            raise HTTPException(status_code=401, detail="Tenant ID not found in auth context")

        # Get user ID
        user_id = request_data.xxai_app_user_id if request_data.xxai_app_user_id else tenant_id

        # Check if the user is banned
        await check_user_ban_status(tenant_id, user_id)

        # Create guardrail service
        guardrail_service = GuardrailService(db)

        # Execute detection
        result = await guardrail_service.check_guardrails(
            guardrail_request,
            ip_address=ip_address,
            user_agent=user_agent,
            tenant_id=tenant_id
        )

        # Check and apply ban policy
        if result.overall_risk_level in ['中风险', '高风险']:
            # Get language setting
            language = get_language_from_request(request, tenant_id)
            await BanPolicyService.check_and_apply_ban_policy(
                tenant_id=tenant_id,
                user_id=user_id,
                risk_level=result.overall_risk_level,
                detection_result_id=result.id,
                language=language
            )

        logger.info(f"Output guardrail check completed: {result.id}, action: {result.suggest_action}, user_id: {user_id}")

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Output guardrail API error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")