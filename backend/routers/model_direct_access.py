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
from database.models import Tenant, ModelUsage
from sqlalchemy import func

logger = setup_logger()
router = APIRouter(tags=["Direct Model Access"])


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

        return {
            "tenant_id": str(tenant.id),
            "email": tenant.email,
            "model_api_key": token
        }
    finally:
        db.close()


async def track_model_usage(
    tenant_id: str,
    model_name: str,
    input_tokens: int = 0,
    output_tokens: int = 0
):
    """
    Track model usage for billing (count only, no content).
    Uses daily aggregation: one record per tenant per model per day.
    """
    db = next(get_admin_db())
    try:
        today = date.today()
        total_tokens = input_tokens + output_tokens

        # Try to find existing record for today
        usage_record = db.query(ModelUsage).filter(
            ModelUsage.tenant_id == tenant_id,
            ModelUsage.model_name == model_name,
            ModelUsage.usage_date == today
        ).first()

        if usage_record:
            # Update existing record
            usage_record.request_count += 1
            usage_record.input_tokens += input_tokens
            usage_record.output_tokens += output_tokens
            usage_record.total_tokens += total_tokens
        else:
            # Create new record
            usage_record = ModelUsage(
                tenant_id=tenant_id,
                model_name=model_name,
                request_count=1,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                total_tokens=total_tokens,
                usage_date=today
            )
            db.add(usage_record)

        db.commit()
        logger.info(f"Tracked model usage: tenant={tenant_id}, model={model_name}, requests={usage_record.request_count}")

    except Exception as e:
        db.rollback()
        logger.error(f"Failed to track model usage: {e}")
        # Don't fail the request if tracking fails
    finally:
        db.close()


def get_model_api_url(model_name: str) -> str:
    """
    Get the API URL for a specific model.
    Maps model names to actual API endpoints.
    """
    model_name_lower = model_name.lower()

    # OpenGuardrails-Text model (guardrails detection model)
    if 'openguardrails-text' in model_name_lower or 'guardrails-text' in model_name_lower:
        return settings.guardrails_model_api_url

    # bge-m3 model (embedding model)
    elif 'bge-m3' in model_name_lower or 'bge' in model_name_lower:
        return settings.embedding_api_base_url

    # Default to guardrails model
    else:
        logger.warning(f"Unknown model '{model_name}', defaulting to guardrails model")
        return settings.guardrails_model_api_url


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

    Supported models:
    - OpenGuardrails-Text (guardrails detection model)
    - bge-m3 (embedding model)
    - Future: vision models

    Example usage:
    ```python
    from openai import OpenAI

    client = OpenAI(
        base_url="https://api.openguardrails.com/v1/",
        api_key="sk-xxai-model-..."
    )

    response = client.chat.completions.create(
        model="OpenGuardrails-Text",
        messages=[{"role": "user", "content": "Hello"}]
    )
    ```
    """
    tenant_id = auth_context["tenant_id"]
    model_name = request_data.model

    logger.info(f"Direct model access: tenant={tenant_id}, model={model_name}, stream={request_data.stream}")

    # Get model API URL
    model_api_url = get_model_api_url(model_name)

    # Prepare auth header for upstream model
    upstream_headers = {
        "Authorization": f"Bearer {settings.guardrails_model_api_key}",
        "Content-Type": "application/json"
    }

    # Prepare request for upstream model
    upstream_request = {
        "model": model_name,
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

                                # Try to extract token usage from chunk
                                try:
                                    if chunk.startswith("data: ") and not chunk.startswith("data: [DONE]"):
                                        data = json.loads(chunk[6:])
                                        if "usage" in data:
                                            input_tokens = data["usage"].get("prompt_tokens", 0)
                                            output_tokens = data["usage"].get("completion_tokens", 0)
                                except:
                                    pass

                # Track usage after streaming completes (best effort)
                if input_tokens or output_tokens:
                    await track_model_usage(tenant_id, model_name, input_tokens, output_tokens)
                else:
                    # No token info available, just track request count
                    await track_model_usage(tenant_id, model_name, 0, 0)

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

                # Extract token usage for tracking
                input_tokens = 0
                output_tokens = 0
                if "usage" in response_data:
                    input_tokens = response_data["usage"].get("prompt_tokens", 0)
                    output_tokens = response_data["usage"].get("completion_tokens", 0)

                # Track usage (async, don't wait)
                await track_model_usage(tenant_id, model_name, input_tokens, output_tokens)

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

    Returns daily usage statistics aggregated by model.
    """
    tenant_id = auth_context["tenant_id"]

    db = next(get_admin_db())
    try:
        # Build query
        query = db.query(ModelUsage).filter(ModelUsage.tenant_id == tenant_id)

        # Apply date filters
        if start_date:
            try:
                start = date.fromisoformat(start_date)
                query = query.filter(ModelUsage.usage_date >= start)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid start_date format. Use YYYY-MM-DD")

        if end_date:
            try:
                end = date.fromisoformat(end_date)
                query = query.filter(ModelUsage.usage_date <= end)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid end_date format. Use YYYY-MM-DD")

        # Get usage records
        usage_records = query.order_by(ModelUsage.usage_date.desc()).all()

        # Format response
        usage_data = []
        for record in usage_records:
            usage_data.append({
                "date": record.usage_date.isoformat(),
                "model_name": record.model_name,
                "request_count": record.request_count,
                "input_tokens": record.input_tokens,
                "output_tokens": record.output_tokens,
                "total_tokens": record.total_tokens
            })

        # Calculate totals
        total_requests = sum(r.request_count for r in usage_records)
        total_tokens = sum(r.total_tokens for r in usage_records)

        return {
            "tenant_id": tenant_id,
            "start_date": start_date,
            "end_date": end_date,
            "total_requests": total_requests,
            "total_tokens": total_tokens,
            "usage_by_day": usage_data
        }

    finally:
        db.close()
