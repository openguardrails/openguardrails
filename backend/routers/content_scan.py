"""
Content Scan Router - API endpoints for email and webpage content scanning

Endpoints:
  POST /scan/email   - Scan email (EML) content for risks
  POST /scan/webpage - Scan webpage content for risks
"""
from datetime import datetime, timezone

from fastapi import APIRouter, Request, HTTPException

from models.scan_models import EmailScanRequest, WebpageScanRequest, ScanResponse
from services.content_scan_service import content_scan_service
from services.async_logger import async_detection_logger
from utils.logger import setup_logger

logger = setup_logger()
router = APIRouter(tags=["Content Scan"])


@router.post("/scan/email", response_model=ScanResponse)
async def scan_email(request_data: EmailScanRequest, request: Request):
    """
    Scan email content for security risks.

    Detects: prompt injection, jailbreak, phishing, malware
    """
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context:
        raise HTTPException(status_code=401, detail="Not authenticated")

    tenant_id = auth_context['data'].get('tenant_id')
    application_id = auth_context['data'].get('application_id')
    ip_address = request.client.host if request.client else None
    user_agent = request.headers.get("user-agent")

    result = await content_scan_service.scan_email(request_data.content)

    # Async logging
    await _log_scan_result(
        result=result,
        content=request_data.content,
        tenant_id=tenant_id,
        application_id=application_id,
        ip_address=ip_address,
        user_agent=user_agent,
    )

    return ScanResponse(**result)


@router.post("/scan/webpage", response_model=ScanResponse)
async def scan_webpage(request_data: WebpageScanRequest, request: Request):
    """
    Scan webpage content for security risks.

    Detects: prompt injection, jailbreak, phishing, malware
    """
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context:
        raise HTTPException(status_code=401, detail="Not authenticated")

    tenant_id = auth_context['data'].get('tenant_id')
    application_id = auth_context['data'].get('application_id')
    ip_address = request.client.host if request.client else None
    user_agent = request.headers.get("user-agent")

    result = await content_scan_service.scan_webpage(request_data.content, request_data.url)

    # Async logging
    await _log_scan_result(
        result=result,
        content=request_data.content,
        tenant_id=tenant_id,
        application_id=application_id,
        ip_address=ip_address,
        user_agent=user_agent,
        url=request_data.url,
    )

    return ScanResponse(**result)


async def _log_scan_result(
    result: dict,
    content: str,
    tenant_id: str,
    application_id: str,
    ip_address: str,
    user_agent: str,
    url: str = None,
):
    """Log scan result asynchronously."""
    try:
        detection_data = {
            "request_id": result["id"],
            "tenant_id": tenant_id,
            "application_id": application_id,
            "content": content[:10000],  # Truncate for logging
            "scan_type": result["scan_type"],
            "risk_level": result["risk_level"],
            "risk_types": result["risk_types"],
            "risk_content": result["risk_content"],
            "score": result["score"],
            "suggest_action": "block" if result["risk_level"] == "high" else "pass",
            "ip_address": ip_address,
            "user_agent": user_agent,
            "url": url,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await async_detection_logger.log_detection(detection_data)
    except Exception as e:
        logger.error(f"Failed to log scan result: {e}")
