"""
Direct Model Access Router
Provides OpenAI-compatible API for direct model access without guardrails.
For privacy: only tracks usage count, never stores actual content.
"""
from fastapi import APIRouter, HTTPException, Request, Depends
from fastapi.responses import StreamingResponse, JSONResponse
from typing import Optional, List, Dict, Any, Union
from pydantic import BaseModel, Field
import httpx
import json
import time
from datetime import date

from config import settings
from utils.logger import setup_logger
from database.connection import get_admin_db
from database.models import Tenant, DetectionResult
from sqlalchemy import func
from services.billing_service import BillingService

logger = setup_logger()
router = APIRouter(tags=["Direct Model Access"])
billing_service = BillingService()


class ChatMessage(BaseModel):
    """Chat message format (OpenAI-compatible)"""
    role: str
    content: Union[str, List[Dict[str, Any]]]


class ChatCompletionRequest(BaseModel):
    """Chat completion request (OpenAI-compatible)"""
    model: str
    messages: List[ChatMessage]
    temperature: Optional[float] = Field(default=0.7, ge=0, le=2)
    top_p: Optional[float] = Field(default=0.9, ge=0, le=1)
    max_tokens: Optional[int] = Field(default=None, ge=1)
    stream: Optional[bool] = False
    # Additional parameters
    frequency_penalty: Optional[float] = Field(default=0, ge=-2, le=2)
    presence_penalty: Optional[float] = Field(default=0, ge=-2, le=2)
    stop: Optional[Union[str, List[str]]] = None
    n: Optional[int] = Field(default=1, ge=1)


async def verify_model_api_key(request: Request) -> dict:
    """
    Verify model API key from Authorization header.
    Returns tenant info if valid, raises HTTPException if invalid.
    """
    auth_header = request.headers.get('authorization')

    if not auth_header or not auth_header.startswith('Bearer '):
        raise HTTPException(
            status_code=401,
            detail="Missing or invalid Authorization header. Expected: Bearer sk-xxai-model-..."
        )

    token = auth_header.split(' ')[1]

    # Verify token format (should start with sk-xxai-model-)
    if not token.startswith('sk-xxai-model-'):
        raise HTTPException(
            status_code=401,
            detail="Invalid model API key format. Expected: sk-xxai-model-..."
        )

    # Look up tenant by model_api_key
    db = next(get_admin_db())
    try:
        tenant = db.query(Tenant).filter(Tenant.model_api_key == token).first()

        if not tenant:
            raise HTTPException(
                status_code=401,
                detail="Invalid model API key"
            )

        # Check subscription status for SaaS mode
        # In enterprise mode (private deployment), subscription check is skipped
        if settings.is_saas_mode:
            # Super admins always have access
            if not tenant.is_super_admin:
                # Check if user has an active subscription
                subscription = billing_service.get_subscription(str(tenant.id), db)

                # Verify subscription is active
                if not subscription or subscription.subscription_type != 'subscribed':
                    raise HTTPException(
                        status_code=403,
                        detail="Direct model access requires an active subscription. Please subscribe at the platform."
                    )

                # Check if subscription has expired
                from datetime import datetime, timezone
                current_time = datetime.now(timezone.utc)
                if subscription.subscription_expires_at and subscription.subscription_expires_at < current_time:
                    raise HTTPException(
                        status_code=403,
                        detail="Your subscription has expired. Please renew your subscription to continue using direct model access."
                    )

                logger.info(f"Subscription verified for tenant {tenant.email} (SaaS mode)")
        else:
            logger.debug(f"Subscription check skipped for tenant {tenant.email} (Enterprise mode)")

        return {
            "tenant_id": str(tenant.id),
            "email": tenant.email,
            "model_api_key": token
        }
    finally:
        db.close()


async def track_direct_model_access(
    tenant_id: str,
    model_name: str,
    request_content: str,
    response_content: str = None,
    ip_address: str = None,
    user_agent: str = None
):
    """
    Track direct model access by creating a DetectionResult record with is_direct_model_access=True.
    This merges counting with regular guardrail calls to check against monthly subscription limits.

    For privacy: by default, stores minimal information (model name only).
    If tenant has enabled log_direct_model_access, stores full request and response content.
    
    For OG-Text model, parses response to detect injection attacks:
    - Response format: {"isInjection": true/false, "confidence": 0.0-1.0, "reason": "...", "findings": [...]}
    - Maps isInjection to security_risk_level (prompt attack)
    """
    import uuid

    db = next(get_admin_db())
    try:
        # Check tenant's log_direct_model_access configuration
        tenant = db.query(Tenant).filter(Tenant.id == tenant_id).first()
        if not tenant:
            logger.warning(f"Tenant {tenant_id} not found when tracking DMA")
            return

        # Determine what content to log based on tenant configuration
        log_enabled = tenant.log_direct_model_access
        if log_enabled:
            # Log full content if enabled
            logged_content = request_content
            logged_response = response_content or ""
            logger.info(f"Logging DMA with full content for tenant={tenant_id} (log_direct_model_access=True)")
        else:
            # Log minimal placeholder for privacy (default behavior)
            logged_content = f"[Direct Model Access: {model_name}]"
            logged_response = ""
            logger.debug(f"Logging DMA with minimal content for tenant={tenant_id} (log_direct_model_access=False)")

        # Parse DMA response for risk detection (for OG-Text model)
        security_risk_level = 'no_risk'
        security_categories = []
        suggest_action = 'pass'
        
        if response_content and model_name and 'og-text' in model_name.lower():
            try:
                # Try to parse the response as JSON
                response_json = json.loads(response_content)
                
                if 'isInjection' in response_json:
                    is_injection = response_json.get('isInjection', False)
                    confidence = response_json.get('confidence', 0.0)
                    reason = response_json.get('reason', '')
                    findings = response_json.get('findings', [])
                    
                    if is_injection:
                        # Map isInjection=true to high_risk prompt attack
                        security_risk_level = 'high_risk'
                        security_categories = ['Prompt Attacks']
                        suggest_action = 'reject'
                        
                        # Extract suspicious content from findings
                        if findings:
                            for finding in findings[:3]:  # Limit to first 3 findings
                                suspicious = finding.get('suspiciousContent', '')
                                if suspicious:
                                    security_categories.append(f"Suspicious: {suspicious[:50]}")
                        
                        logger.info(f"DMA detected injection: confidence={confidence}, reason={reason}")
                    else:
                        security_risk_level = 'no_risk'
                        security_categories = []
                        suggest_action = 'pass'
                        logger.debug(f"DMA: No injection detected (confidence={confidence})")
                        
            except json.JSONDecodeError:
                logger.debug(f"DMA response is not JSON, treating as safe content")
            except Exception as e:
                logger.warning(f"Failed to parse DMA response for risk detection: {e}")

        # Create a detection result record for direct model access
        # Note: application_id is nullable since direct model access uses model_api_key (tenant-level)
        detection_result = DetectionResult(
            request_id=str(uuid.uuid4()),
            tenant_id=tenant_id,
            application_id=None,  # Direct model access is tenant-level, not application-specific
            content=logged_content,  # Full content if logging enabled, minimal placeholder otherwise
            is_direct_model_access=True,  # Mark as direct model access
            suggest_action=suggest_action,  # 'pass' or 'reject' based on risk
            suggest_answer=None,
            hit_keywords=None,
            model_response=logged_response,  # Store model response if logging enabled
            security_risk_level=security_risk_level,  # Parsed from DMA response
            security_categories=security_categories,  # Parsed from DMA response
            compliance_risk_level='no_risk',
            compliance_categories=[],
            data_risk_level='no_risk',
            data_categories=[],
            has_image=False,
            image_count=0,
            image_paths=[],
            ip_address=ip_address,
            user_agent=user_agent
        )

        db.add(detection_result)
        db.commit()
        logger.info(f"Tracked direct model access: tenant={tenant_id}, model={model_name}, logged={log_enabled}, risk={security_risk_level}")

    except Exception as e:
        db.rollback()
        logger.error(f"Failed to track direct model access: {e}")
        # Don't fail the request if tracking fails
    finally:
        db.close()


def get_model_config(model_name: str) -> dict:
    """
    Get the backend API configuration based on the requested model name.
    
    This function determines which backend API endpoint to route to based on model name patterns,
    but does NOT substitute the model name. The user's requested model name will be passed 
    through as-is to the upstream API.

    Routing logic:
    - Text models (openguardrails-text, guardrails-text, og-text) → GUARDRAILS_MODEL_API
    - Vision models (openguardrails-vl, guardrails-vl, og-vl) → GUARDRAILS_VL_MODEL_API
    - Embedding models (bge-m3, bge, embedding) → EMBEDDING_API
    - Other models → Default to GUARDRAILS_MODEL_API

    Returns:
        dict with keys: api_url, api_key, model_name (deprecated, not used in direct access)
    """
    model_name_lower = model_name.lower()

    # OpenGuardrails-Text model (guardrails detection model)
    if 'openguardrails-text' in model_name_lower or 'guardrails-text' in model_name_lower or 'og-text' in model_name_lower:
        return {
            'api_url': settings.guardrails_model_api_url,
            'api_key': settings.guardrails_model_api_key,
            'model_name': settings.guardrails_model_name
        }

    # OpenGuardrails-VL model (vision-language model)
    elif 'openguardrails-vl' in model_name_lower or 'guardrails-vl' in model_name_lower or 'og-vl' in model_name_lower:
        return {
            'api_url': settings.guardrails_vl_model_api_url,
            'api_key': settings.guardrails_vl_model_api_key,
            'model_name': settings.guardrails_vl_model_name
        }

    # Embedding model (bge-m3 or similar)
    elif 'bge-m3' in model_name_lower or 'bge' in model_name_lower or 'embedding' in model_name_lower:
        return {
            'api_url': settings.embedding_api_base_url,
            'api_key': settings.embedding_api_key,
            'model_name': settings.embedding_model_name
        }

    # Default to guardrails text model API (let upstream decide if model is valid)
    else:
        return {
            'api_url': settings.guardrails_model_api_url,
            'api_key': settings.guardrails_model_api_key,
            'model_name': settings.guardrails_model_name
        }


@router.post("/model/")
@router.post("/model/chat/completions")
async def model_chat_completions(
    request_data: ChatCompletionRequest,
    request: Request,
    auth_context: dict = Depends(verify_model_api_key)
):
    """
    OpenAI-compatible chat completions endpoint for direct model access.

    PRIVACY NOTICE: This endpoint does NOT store message content.
    Only usage statistics (count, tokens) are tracked for billing.

    Model routing:
    - The exact model name you specify will be passed to the upstream API
    - The system automatically routes to the correct backend based on model name patterns
    - Example: "OG-Text" → routes to guardrails API, sends "OG-Text" to upstream
    - Example: "bge-m3" → routes to embedding API, sends "bge-m3" to upstream

    Example usage:
    ```python
    from openai import OpenAI

    client = OpenAI(
        base_url="https://api.openguardrails.com/v1/model/",
        api_key="sk-xxai-model-..."
    )

    response = client.chat.completions.create(
        model="OG-Text",  # Your requested model name is sent as-is to upstream
        messages=[{"role": "user", "content": "Hello"}]
    )
    ```
    """
    tenant_id = auth_context["tenant_id"]
    requested_model_name = request_data.model

    # Extract IP address and user agent for tracking
    ip_address = request.client.host if request.client else None
    user_agent = request.headers.get('user-agent')

    logger.info(f"Direct model access: tenant={tenant_id}, model={requested_model_name}, stream={request_data.stream}")

    # Get complete model configuration (URL, API Key)
    model_config = get_model_config(requested_model_name)
    model_api_url = model_config['api_url']
    model_api_key = model_config['api_key']
    # Note: We pass through the user's requested model name directly to upstream

    # Prepare auth header for upstream model (use the correct API key for this model)
    upstream_headers = {
        "Authorization": f"Bearer {model_api_key}",
        "Content-Type": "application/json"
    }

    # Prepare request for upstream model (use the user's requested model name as-is)
    upstream_request = {
        "model": requested_model_name,
        "messages": [
            {"role": msg.role, "content": msg.content}
            for msg in request_data.messages
        ],
        "temperature": request_data.temperature,
        "top_p": request_data.top_p,
        "stream": request_data.stream,
    }

    # Add optional parameters
    if request_data.max_tokens:
        upstream_request["max_tokens"] = request_data.max_tokens
    if request_data.frequency_penalty:
        upstream_request["frequency_penalty"] = request_data.frequency_penalty
    if request_data.presence_penalty:
        upstream_request["presence_penalty"] = request_data.presence_penalty
    if request_data.stop:
        upstream_request["stop"] = request_data.stop
    if request_data.n:
        upstream_request["n"] = request_data.n

    try:
        # Make request to upstream model
        if request_data.stream:
            # Streaming response
            async def stream_response():
                input_tokens = 0
                output_tokens = 0
                accumulated_response = []  # Accumulate response content

                # Create client inside stream_response to keep it alive during streaming
                async with httpx.AsyncClient(timeout=120.0) as client:
                    async with client.stream(
                        "POST",
                        f"{model_api_url}/chat/completions",
                        json=upstream_request,
                        headers=upstream_headers
                    ) as response:
                        response.raise_for_status()

                        async for chunk in response.aiter_text():
                            if chunk.strip():
                                yield chunk

                                # Accumulate response content
                                accumulated_response.append(chunk)

                                # Try to extract token usage from chunk
                                try:
                                    if chunk.startswith("data: ") and not chunk.startswith("data: [DONE]"):
                                        data = json.loads(chunk[6:])
                                        if "usage" in data:
                                            input_tokens = data["usage"].get("prompt_tokens", 0)
                                            output_tokens = data["usage"].get("completion_tokens", 0)
                                except:
                                    pass

                # Track direct model access after streaming completes
                # Pass the actual messages content for logging (will be filtered based on tenant config)
                messages_content = " ".join([f"{msg.role}: {msg.content}" for msg in request_data.messages])
                response_content = "".join(accumulated_response)
                
                await track_direct_model_access(
                    tenant_id=tenant_id,
                    model_name=requested_model_name,
                    request_content=f"[Streaming] {messages_content}",
                    response_content=response_content,
                    ip_address=ip_address,
                    user_agent=user_agent
                )

            return StreamingResponse(
                stream_response(),
                media_type="text/event-stream"
            )
        else:
            # Non-streaming response
            async with httpx.AsyncClient(timeout=120.0) as client:
                response = await client.post(
                    f"{model_api_url}/chat/completions",
                    json=upstream_request,
                    headers=upstream_headers
                )
                response.raise_for_status()
                response_data = response.json()

                # Extract response content for logging and risk analysis
                response_content = ""
                try:
                    # Extract the assistant's message content from response
                    if "choices" in response_data and len(response_data["choices"]) > 0:
                        choice = response_data["choices"][0]
                        if "message" in choice and "content" in choice["message"]:
                            response_content = choice["message"]["content"]
                except Exception as e:
                    logger.warning(f"Failed to extract response content: {e}")

                # Track direct model access
                # Pass the actual messages content for logging (will be filtered based on tenant config)
                messages_content = " ".join([f"{msg.role}: {msg.content}" for msg in request_data.messages])
                await track_direct_model_access(
                    tenant_id=tenant_id,
                    model_name=requested_model_name,
                    request_content=messages_content,
                    response_content=response_content,
                    ip_address=ip_address,
                    user_agent=user_agent
                )

                return JSONResponse(content=response_data)

    except httpx.HTTPStatusError as e:
        logger.error(f"Model API error: {e.response.status_code} - {e.response.text}")
        raise HTTPException(
            status_code=e.response.status_code,
            detail=f"Model API error: {e.response.text}"
        )
    except httpx.RequestError as e:
        logger.error(f"Model API request error: {e}")
        raise HTTPException(
            status_code=503,
            detail=f"Failed to connect to model API: {str(e)}"
        )
    except Exception as e:
        logger.error(f"Unexpected error in direct model access: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Internal error: {str(e)}"
        )


class EmbeddingRequest(BaseModel):
    """Embedding request (OpenAI-compatible)"""
    model: str
    input: Union[str, List[str]]
    encoding_format: Optional[str] = Field(default="float")
    dimensions: Optional[int] = None
    user: Optional[str] = None


@router.post("/model/embeddings")
async def model_embeddings(
    request_data: EmbeddingRequest,
    request: Request,
    auth_context: dict = Depends(verify_model_api_key)
):
    """
    OpenAI-compatible embeddings endpoint for direct model access.

    PRIVACY NOTICE: This endpoint does NOT store input content.
    Only usage statistics (count) are tracked for billing.

    Example usage:
    ```python
    from openai import OpenAI

    client = OpenAI(
        base_url="https://api.openguardrails.com/v1/model/",
        api_key="sk-xxai-model-..."
    )

    response = client.embeddings.create(
        model="bge-m3",
        input="Hello, world!"
    )
    ```
    """
    tenant_id = auth_context["tenant_id"]
    requested_model_name = request_data.model

    # Extract IP address and user agent for tracking
    ip_address = request.client.host if request.client else None
    user_agent = request.headers.get('user-agent')

    logger.info(f"Direct model access (embeddings): tenant={tenant_id}, model={requested_model_name}")

    # Get complete model configuration (URL, API Key)
    model_config = get_model_config(requested_model_name)
    model_api_url = model_config['api_url']
    model_api_key = model_config['api_key']

    # Prepare auth header for upstream model
    upstream_headers = {
        "Authorization": f"Bearer {model_api_key}",
        "Content-Type": "application/json"
    }

    # Prepare request for upstream model (use the user's requested model name as-is)
    upstream_request = {
        "model": requested_model_name,
        "input": request_data.input,
    }

    # Add optional parameters
    if request_data.encoding_format:
        upstream_request["encoding_format"] = request_data.encoding_format
    if request_data.dimensions:
        upstream_request["dimensions"] = request_data.dimensions
    if request_data.user:
        upstream_request["user"] = request_data.user

    try:
        # Make request to upstream embedding API
        async with httpx.AsyncClient(timeout=120.0) as client:
            response = await client.post(
                f"{model_api_url}/embeddings",
                json=upstream_request,
                headers=upstream_headers
            )
            response.raise_for_status()
            response_data = response.json()

            # Track direct model access
            # Pass the actual input for logging (will be filtered based on tenant config)
            input_content = str(request_data.input)
            # For embeddings, response is just vectors, not useful for risk analysis
            await track_direct_model_access(
                tenant_id=tenant_id,
                model_name=requested_model_name,
                request_content=f"[Embeddings] {input_content}",
                response_content="[Embedding vectors]",
                ip_address=ip_address,
                user_agent=user_agent
            )

            return JSONResponse(content=response_data)

    except httpx.HTTPStatusError as e:
        logger.error(f"Embedding API error: {e.response.status_code} - {e.response.text}")
        raise HTTPException(
            status_code=e.response.status_code,
            detail=f"Embedding API error: {e.response.text}"
        )
    except httpx.RequestError as e:
        logger.error(f"Embedding API request error: {e}")
        raise HTTPException(
            status_code=503,
            detail=f"Failed to connect to embedding API: {str(e)}"
        )
    except Exception as e:
        logger.error(f"Unexpected error in embeddings access: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Internal error: {str(e)}"
        )


@router.get("/model/usage")
async def get_model_usage(
    request: Request,
    auth_context: dict = Depends(verify_model_api_key),
    start_date: Optional[str] = None,
    end_date: Optional[str] = None
):
    """
    Get model usage statistics for the authenticated tenant.

    Query parameters:
    - start_date: Start date (YYYY-MM-DD format, optional)
    - end_date: End date (YYYY-MM-DD format, optional)

    Returns usage count for direct model access calls.
    Note: Direct model access calls are now tracked in detection_results with is_direct_model_access=True
    """
    from datetime import datetime
    from sqlalchemy import cast, Date

    tenant_id = auth_context["tenant_id"]

    db = next(get_admin_db())
    try:
        # Build query for direct model access records
        query = db.query(DetectionResult).filter(
            DetectionResult.tenant_id == tenant_id,
            DetectionResult.is_direct_model_access == True
        )

        # Apply date filters
        if start_date:
            try:
                start = datetime.fromisoformat(start_date)
                query = query.filter(DetectionResult.created_at >= start)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid start_date format. Use YYYY-MM-DD")

        if end_date:
            try:
                end = datetime.fromisoformat(end_date)
                # Add one day to include the end date
                from datetime import timedelta
                end = end + timedelta(days=1)
                query = query.filter(DetectionResult.created_at < end)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid end_date format. Use YYYY-MM-DD")

        # Get all direct model access records
        usage_records = query.order_by(DetectionResult.created_at.desc()).all()

        # Group by date
        from collections import defaultdict
        usage_by_date = defaultdict(int)
        for record in usage_records:
            record_date = record.created_at.date().isoformat()
            usage_by_date[record_date] += 1

        # Format response
        usage_data = [
            {"date": date_str, "request_count": count}
            for date_str, count in sorted(usage_by_date.items(), reverse=True)
        ]

        return {
            "tenant_id": tenant_id,
            "start_date": start_date,
            "end_date": end_date,
            "total_requests": len(usage_records),
            "usage_by_day": usage_data
        }

    finally:
        db.close()
