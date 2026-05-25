from fastapi import APIRouter, Depends, Request, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from database.connection import get_async_admin_db
from services.detection_guardrail_service import DetectionGuardrailService
from services.rate_limiter import RateLimitService
from utils.i18n import get_language_from_request
from models.requests import GuardrailRequest, InputGuardrailRequest, OutputGuardrailRequest, Message
from models.responses import GuardrailResponse
from utils.logger import setup_logger

logger = setup_logger()
router = APIRouter(tags=["Detection Guardrails"])


# ---------------------------------------------------------------------------
# Phase 3: this router is now async on the request entry path. The monthly
# quota check (previously a sync DB transaction inside `next(get_admin_db())`
# that blocked the event loop on every request) now runs on AsyncSession
# via RateLimitService.check_and_increment_monthly_usage_async.
#
# DetectionGuardrailService internals still contain a handful of sync DB
# lookups; those are converted in a separate pass — see
# docs/REFACTOR_PLAN.md "Async router migration progress".
# ---------------------------------------------------------------------------


def _extract_request_context(request: Request, fallback_user_id: str = None):
    """Pull tenant_id / application_id / user_id / IP / UA out of a request.

    Centralized to keep the three endpoints below identical in how they
    handle auth context, header overrides, and user-id fallback.
    Returns (tenant_id, application_id, user_id, ip_address, user_agent).
    Raises HTTPException(401) when no tenant is resolved.
    """
    ip_address = request.client.host if request.client else None
    user_agent = request.headers.get("user-agent")

    auth_context = getattr(request.state, 'auth_context', None)
    tenant_id = None
    application_id = None
    if auth_context:
        tenant_id = str(auth_context['data'].get('tenant_id'))
        application_id = auth_context['data'].get('application_id')

    # X-Application-ID header overrides auth context (frontend / online test).
    header_app_id = request.headers.get('x-application-id') or request.headers.get('X-Application-ID')
    if header_app_id:
        application_id = header_app_id
        logger.info(f"Using application_id from header: {application_id}")

    if not tenant_id:
        raise HTTPException(status_code=401, detail="User ID not found in auth context")

    user_id = fallback_user_id or tenant_id

    return tenant_id, application_id, user_id, ip_address, user_agent


async def _enforce_monthly_quota(db: AsyncSession, tenant_id: str) -> None:
    """Raise HTTPException(429) if the tenant has burned through their
    monthly quota; otherwise increment the usage counter."""
    is_allowed, current_usage, monthly_limit = (
        await RateLimitService.check_and_increment_monthly_usage_async(db, tenant_id)
    )
    if not is_allowed:
        logger.warning(
            f"Monthly scan limit exceeded for tenant {tenant_id}: "
            f"{current_usage}/{monthly_limit}"
        )
        raise HTTPException(
            status_code=429,
            detail=f"Monthly scan limit exceeded. Used {current_usage}/{monthly_limit} scans this month.",
        )
    if current_usage and monthly_limit:
        logger.info(f"Monthly usage for tenant {tenant_id}: {current_usage}/{monthly_limit}")


@router.post("/guardrails", response_model=GuardrailResponse)
async def check_guardrails(
    request_data: GuardrailRequest,
    request: Request,
    db: AsyncSession = Depends(get_async_admin_db),
):
    """Guardrail detection API — detection-service variant (logs only, no DB write)."""
    try:
        # extra_body.xxai_app_user_id overrides the tenant_id fallback for
        # the user-id field used in logging / ban-policy.
        body_user_id = None
        if request_data.extra_body:
            body_user_id = request_data.extra_body.get('xxai_app_user_id')

        tenant_id, application_id, user_id, ip_address, user_agent = (
            _extract_request_context(request, fallback_user_id=body_user_id)
        )

        await _enforce_monthly_quota(db, tenant_id)

        guardrail_service = DetectionGuardrailService()

        result = await guardrail_service.check_guardrails(
            request_data,
            ip_address=ip_address,
            user_agent=user_agent,
            tenant_id=tenant_id,
            application_id=application_id,
            user_id=user_id,
        )

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
        "timestamp": "2025-01-01T00:00:00Z",
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
        ],
    }


@router.post("/guardrails/input", response_model=GuardrailResponse)
async def check_input_guardrails(
    request_data: InputGuardrailRequest,
    request: Request,
    db: AsyncSession = Depends(get_async_admin_db),
):
    """Input detection API — for Dify / Coze etc. agent platform plugins."""
    try:
        # Translate the simpler input-only payload into the standard
        # GuardrailRequest shape that the service expects.
        messages = [Message(role="user", content=request_data.input)]
        guardrail_request = GuardrailRequest(
            model="OpenGuardrails-Text",
            messages=messages,
        )

        tenant_id, application_id, user_id, ip_address, user_agent = (
            _extract_request_context(request, fallback_user_id=request_data.xxai_app_user_id)
        )

        await _enforce_monthly_quota(db, tenant_id)

        guardrail_service = DetectionGuardrailService()

        result = await guardrail_service.check_guardrails(
            guardrail_request,
            ip_address=ip_address,
            user_agent=user_agent,
            tenant_id=tenant_id,
            application_id=application_id,
            user_id=user_id,
        )

        logger.info(f"Input detection completed: {result.id}, action: {result.suggest_action}")
        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Input detection API error: {e}")
        raise HTTPException(status_code=500, detail="Detection service error")


@router.post("/guardrails/output", response_model=GuardrailResponse)
async def check_output_guardrails(
    request_data: OutputGuardrailRequest,
    request: Request,
    db: AsyncSession = Depends(get_async_admin_db),
):
    """Output detection API — for Dify / Coze etc. agent platform plugins."""
    try:
        # Both input and output are passed: model the conversation as
        # user prompt followed by assistant reply.
        messages = [
            Message(role="user", content=request_data.input),
            Message(role="assistant", content=request_data.output),
        ]
        guardrail_request = GuardrailRequest(
            model="OpenGuardrails-Text",
            messages=messages,
        )

        tenant_id, application_id, user_id, ip_address, user_agent = (
            _extract_request_context(request, fallback_user_id=request_data.xxai_app_user_id)
        )

        await _enforce_monthly_quota(db, tenant_id)

        guardrail_service = DetectionGuardrailService()

        result = await guardrail_service.check_guardrails(
            guardrail_request,
            ip_address=ip_address,
            user_agent=user_agent,
            tenant_id=tenant_id,
            application_id=application_id,
            user_id=user_id,
        )

        logger.info(f"Output detection completed: {result.id}, action: {result.suggest_action}")
        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Output detection API error: {e}")
        raise HTTPException(status_code=500, detail="Detection service error")
