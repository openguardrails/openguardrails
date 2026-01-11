"""
Gateway Integration API

Provides unified API endpoints for third-party AI gateways (Higress, LiteLLM, Kong, etc.)
to integrate OpenGuardrails' full security capabilities.

Endpoints:
- POST /v1/gateway/process-input  - Process incoming messages through detection pipeline
- POST /v1/gateway/process-output - Process LLM output with restoration

See docs/THIRD_PARTY_GATEWAY_INTEGRATION.md for full documentation.
"""

from fastapi import APIRouter, HTTPException, Request, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import Dict, Any, Optional, List
import time

from database.connection import get_db
from sqlalchemy.orm import Session
from services.gateway_integration_service import get_gateway_integration_service
from utils.logger import setup_logger

router = APIRouter(prefix="/v1/gateway", tags=["Gateway Integration"])
logger = setup_logger()


class ProcessInputRequest(BaseModel):
    """Request model for process-input endpoint"""
    messages: List[Dict[str, Any]] = Field(..., description="OpenAI-format messages array")
    stream: bool = Field(default=False, description="Whether the request is for streaming response")
    client_ip: Optional[str] = Field(default=None, description="Client IP address for ban policy")
    user_id: Optional[str] = Field(default=None, description="User identifier for ban policy")

    class Config:
        json_schema_extra = {
            "example": {
                "messages": [
                    {"role": "user", "content": "My email is john@example.com"}
                ],
                "stream": False
            }
        }


class ProcessOutputRequest(BaseModel):
    """Request model for process-output endpoint"""
    content: str = Field(..., description="LLM response content")
    session_id: Optional[str] = Field(default=None, description="Session ID from process-input for restoration")
    is_streaming: bool = Field(default=False, description="Whether this is a streaming chunk")
    chunk_index: int = Field(default=0, description="Chunk index for streaming (0-based)")

    class Config:
        json_schema_extra = {
            "example": {
                "content": "I have received your email [email_1]",
                "session_id": "sess_abc123def456"
            }
        }


def get_auth_info_from_request(request: Request) -> Dict[str, str]:
    """Extract tenant_id and application_id from request auth context"""
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context:
        raise HTTPException(
            status_code=401,
            detail={"error": {"message": "Authentication required", "type": "authentication_error"}}
        )

    # Auth context structure: {"type": "...", "data": {"tenant_id": "...", "application_id": "...", ...}}
    data = auth_context.get('data', {})
    tenant_id = data.get('tenant_id')
    application_id = data.get('application_id')

    if not tenant_id or not application_id:
        raise HTTPException(
            status_code=401,
            detail={"error": {"message": "Invalid API key - must use application API key", "type": "authentication_error"}}
        )

    return {"tenant_id": tenant_id, "application_id": application_id}


@router.post("/process-input")
async def process_input(
    request: Request,
    body: ProcessInputRequest,
    db: Session = Depends(get_db)
):
    """
    Process incoming messages through OpenGuardrails' full detection pipeline.

    Authentication: Use application API key (Bearer sk-xxai-xxx).
    The application_id is automatically extracted from the API key.

    This endpoint performs:
    1. Ban policy check (user/IP)
    2. Blacklist/Whitelist keyword check
    3. Data leakage prevention (DLP) detection
    4. Security/Compliance scanning (21 risk categories)
    5. Risk aggregation and disposition decision

    Returns an action and any necessary data for the gateway to execute:
    - **block**: Return error response to client
    - **replace**: Return knowledge base / template response
    - **anonymize**: Forward anonymized messages to LLM
    - **switch_private_model**: Redirect to private/on-premise model
    - **pass**: Forward request as-is
    """
    start_time = time.time()

    # Get tenant_id and application_id from API key
    auth_info = get_auth_info_from_request(request)
    tenant_id = auth_info["tenant_id"]
    application_id = auth_info["application_id"]

    # Debug: log received messages
    logger.info(f"Gateway process-input received: messages_count={len(body.messages)}, stream={body.stream}")
    if body.messages:
        for i, msg in enumerate(body.messages):
            logger.info(f"  Message {i}: role={msg.get('role')}, content_len={len(str(msg.get('content', '')))}, content_preview={str(msg.get('content', ''))[:100]}")

    service = get_gateway_integration_service(db)

    result = await service.process_input(
        application_id=application_id,
        tenant_id=tenant_id,
        messages=body.messages,
        stream=body.stream,
        client_ip=body.client_ip,
        user_id=body.user_id
    )

    # Add timing info
    result["processing_time_ms"] = round((time.time() - start_time) * 1000, 2)

    logger.info(
        f"Gateway process-input: app={application_id[:8]}..., "
        f"action={result.get('action')}, "
        f"risk={result.get('detection_result', {}).get('overall_risk_level', 'unknown')}, "
        f"time={result['processing_time_ms']}ms"
    )

    return JSONResponse(content=result)


@router.post("/process-output")
async def process_output(
    request: Request,
    body: ProcessOutputRequest,
    db: Session = Depends(get_db)
):
    """
    Process LLM output through detection and optionally restore anonymized data.

    Authentication: Use application API key (Bearer sk-xxai-xxx).
    The application_id is automatically extracted from the API key.

    This endpoint:
    1. Restores anonymized placeholders if session_id is provided
    2. Runs output detection for security/compliance risks
    3. Returns appropriate action and content

    Returns:
    - **block**: Output contains security risk, return error
    - **replace**: Output contains compliance risk, return template
    - **restore**: Return restored content (anonymized placeholders replaced with originals)
    - **pass**: Return content as-is
    """
    start_time = time.time()

    # Get tenant_id and application_id from API key
    auth_info = get_auth_info_from_request(request)
    tenant_id = auth_info["tenant_id"]
    application_id = auth_info["application_id"]

    service = get_gateway_integration_service(db)

    result = await service.process_output(
        application_id=application_id,
        tenant_id=tenant_id,
        content=body.content,
        session_id=body.session_id,
        is_streaming=body.is_streaming,
        chunk_index=body.chunk_index
    )

    # Add timing info
    result["processing_time_ms"] = round((time.time() - start_time) * 1000, 2)

    logger.info(
        f"Gateway process-output: app={application_id[:8]}..., "
        f"action={result.get('action')}, "
        f"session={'yes' if body.session_id else 'no'}, "
        f"time={result['processing_time_ms']}ms"
    )

    return JSONResponse(content=result)


@router.get("/health")
async def health_check():
    """Health check endpoint for gateway integration"""
    return {"status": "healthy", "service": "gateway-integration", "version": "1.0.0"}
