"""
Reverse proxy API route - OpenAI compatible guardrail proxy interface

Architecture:
- Input detection: synchronous via GatewayIntegrationService.process_input()
- Streaming output: real-time passthrough, async output detection after stream ends
- Non-streaming output: synchronous detection via GatewayIntegrationService.process_output()
- Same detection pipeline as Higress/LiteLLM integrations (unified code path)
"""
from fastapi import APIRouter, HTTPException, Request, Depends
from fastapi.responses import JSONResponse, StreamingResponse
from typing import Dict, Any, Optional, List, Union
from pydantic import BaseModel
from sqlalchemy import select
import httpx
import json
import time
import asyncio
import uuid
from datetime import datetime

from models.requests import ProxyCompletionRequest
from models.responses import ProxyCompletionResponse, ProxyModelListResponse
from services.proxy_service import proxy_service
from services.billing_service import billing_service
from services.model_route_service import model_route_service
from services.gateway_integration_service import (
    get_gateway_integration_service,
    get_async_gateway_integration_service,
)
from database.connection import (
    get_db, get_admin_db_session,
    get_async_detection_db_session, get_async_admin_db_session,
)
from utils.logger import setup_logger

router = APIRouter()
logger = setup_logger()


# ============================================================================
# Async Output Detection (for streaming mode)
# ============================================================================

async def _async_output_detection_via_service(
    application_id: str, tenant_id: str,
    content: str, restore_mapping: Optional[Dict[str, str]],
    input_messages: list, request_id: str,
):
    """Run output detection asynchronously after streaming completes.
    Results are logged only (cannot unsend already-streamed chunks).

    Phase 3: opens its own AsyncSession internally — the caller no longer
    has to construct a sync session and pass it in. This matters because
    this coroutine runs as a fire-and-forget `asyncio.create_task`, and
    the previous design depended on the caller's sync session staying
    alive for the duration of the task (a footgun in multi-worker setups
    where the caller's session got closed by the request lifecycle)."""
    try:
        async with get_async_detection_db_session() as db:
            service = get_async_gateway_integration_service(db)
            result = await service.process_output(
                application_id=application_id,
                tenant_id=tenant_id,
                content=content,
                restore_mapping=restore_mapping,
                input_messages=input_messages,
                source="proxy",
            )
        action = result.get("action", "pass")
        detection_id = result.get("detection_result", {}).get("detection_id")
        if action in ("block", "replace"):
            logger.warning(
                f"[{request_id}] Async output detection found risk (action={action}, "
                f"detection_id={detection_id}) but stream already sent. Risk logged for audit."
            )
        else:
            logger.info(f"[{request_id}] Async output detection passed (action={action})")
        return result
    except Exception as e:
        logger.error(f"[{request_id}] Async output detection failed: {e}")
        return None


# ============================================================================
# Gateway Pattern Response Handlers
# ============================================================================

async def _handle_gateway_streaming_response(
    upstream_response, api_config, tenant_id: str, request_id: str,
    input_detection_id: str, user_id: str, model_name: str, start_time: float,
    input_messages: list, application_id: str = None,
    restore_mapping: Optional[Dict[str, str]] = None
):
    """Handle gateway streaming response with real-time chunk passthrough.

    Architecture (same as Higress integration):
    1. Stream chunks to client in real-time (no buffering)
    2. Accumulate full content in background
    3. After stream ends, run async output detection (log-only, can't unsend)
    4. If restore_mapping exists, restore anonymized placeholders in real-time
    """
    try:
        from services.restore_anonymization_service import StreamingRestoreBuffer

        has_restore_mapping = bool(restore_mapping)
        restore_buffer = StreamingRestoreBuffer(restore_mapping) if has_restore_mapping else None

        if has_restore_mapping:
            logger.info(f"Gateway streaming: Using restore buffer with {len(restore_mapping)} mappings")

        async def stream_generator():
            nonlocal restore_buffer, has_restore_mapping
            full_content = ""
            output_blocked = False

            try:
                async with upstream_response as response:
                    if response.status_code >= 400:
                        error_body = await response.aread()
                        logger.error(f"[UpstreamError] status={response.status_code}, body={error_body.decode('utf-8', errors='replace')[:2000]}")
                    response.raise_for_status()

                    async for line in response.aiter_lines():
                        if not line.strip():
                            continue
                        if not line.startswith("data: "):
                            continue

                        data = line[6:]

                        if data.strip() == "[DONE]":
                            # Flush any remaining content in restore buffer
                            if has_restore_mapping and restore_buffer and restore_buffer.has_pending_content():
                                remaining = restore_buffer.flush()
                                if remaining:
                                    flush_chunk = {
                                        "id": f"chatcmpl-{request_id}",
                                        "object": "chat.completion.chunk",
                                        "created": int(time.time()),
                                        "model": model_name,
                                        "choices": [{
                                            "index": 0,
                                            "delta": {"content": remaining}
                                        }]
                                    }
                                    yield f"data: {json.dumps(flush_chunk)}\n\n"

                            yield "data: [DONE]\n\n"

                            # Async output detection after stream ends.
                            # The helper opens its own AsyncSession — we
                            # no longer hand it a sync session that might
                            # close before the task gets scheduled.
                            try:
                                asyncio.create_task(
                                    _async_output_detection_via_service(
                                        application_id, tenant_id,
                                        full_content, restore_mapping,
                                        input_messages, request_id,
                                    )
                                )
                            except Exception as e:
                                logger.error(f"[{request_id}] Failed to start async output detection: {e}")
                            break

                        try:
                            chunk_data = json.loads(data)
                        except json.JSONDecodeError:
                            continue

                        # Extract content for accumulation
                        if 'choices' in chunk_data and chunk_data['choices']:
                            delta = chunk_data['choices'][0].get('delta', {})
                            content = delta.get('content') or ''
                            reasoning_content = delta.get('reasoning_content') or ''
                            full_content += content + reasoning_content

                            # Extract tool_calls content for accumulation
                            tool_calls = delta.get('tool_calls')
                            if tool_calls:
                                for tc in tool_calls:
                                    if 'function' in tc:
                                        func = tc['function']
                                        full_content += func.get('name', '') + func.get('arguments', '')

                        # Real-time restore if we have restore mapping
                        if has_restore_mapping and restore_buffer:
                            if 'choices' in chunk_data and chunk_data['choices']:
                                delta = chunk_data['choices'][0].get('delta', {})
                                chunk_content = delta.get('content', '')
                                if chunk_content:
                                    restored_content = restore_buffer.process_chunk(chunk_content)
                                    if restored_content:
                                        modified_chunk = json.loads(json.dumps(chunk_data))
                                        modified_chunk['choices'][0]['delta']['content'] = restored_content
                                        yield f"data: {json.dumps(modified_chunk)}\n\n"
                                    # If no content ready (buffered for partial placeholder), skip
                                else:
                                    yield f"data: {json.dumps(chunk_data)}\n\n"
                            else:
                                yield f"data: {json.dumps(chunk_data)}\n\n"
                        else:
                            # No restore needed, pass through directly
                            yield f"data: {json.dumps(chunk_data)}\n\n"

                # Log request
                await proxy_service.log_proxy_request_gateway(
                    request_id=request_id,
                    tenant_id=tenant_id,
                    upstream_api_config_id=str(api_config.id),
                    model_requested=model_name,
                    model_used=model_name,
                    provider=api_config.provider or "unknown",
                    input_detection_id=input_detection_id,
                    output_detection_id=None,  # async detection, ID not yet available
                    input_blocked=False,
                    output_blocked=output_blocked,
                    status="stream_success",
                    response_time_ms=int((time.time() - start_time) * 1000)
                )

            except Exception as e:
                logger.error(f"Gateway streaming error: {e}")
                error_chunk = {
                    "id": f"chatcmpl-{request_id}",
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": model_name,
                    "choices": [{
                        "index": 0,
                        "delta": {"role": "assistant", "content": f"Error: {str(e)}"},
                        "finish_reason": "error"
                    }]
                }
                yield f"data: {json.dumps(error_chunk)}\n\n"
                yield "data: [DONE]\n\n"

        return StreamingResponse(
            stream_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no"
            }
        )

    except Exception as e:
        logger.error(f"Gateway streaming handler error: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": {"message": str(e), "type": "internal_error"}}
        )


async def _handle_gateway_non_streaming_response(
    upstream_response, api_config, tenant_id: str, request_id: str,
    input_detection_id: str, user_id: str, model_name: str, start_time: float,
    input_messages: list, application_id: str = None,
    restore_mapping: Optional[Dict[str, str]] = None
):
    """Handle gateway non-streaming response with synchronous output detection
    via GatewayIntegrationService.process_output()"""
    try:
        output_detection_id = None
        output_blocked = False

        if upstream_response.get('choices'):
            message = upstream_response['choices'][0]['message']
            output_content = message.get('content') or ''

            # Extract tool_calls content for detection
            tool_calls_content = ""
            if 'tool_calls' in message and message['tool_calls']:
                tool_calls_text = []
                for tool_call in message['tool_calls']:
                    if 'function' in tool_call:
                        func = tool_call['function']
                        func_name = func.get('name', '')
                        func_args = func.get('arguments', '')
                        tool_calls_text.append(f"[Tool Call] {func_name}({func_args})")
                tool_calls_content = ' '.join(tool_calls_text)

            # Combine all content for detection
            combined_content = output_content
            if tool_calls_content:
                combined_content = f"{output_content}\n{tool_calls_content}" if output_content else tool_calls_content

            # Run output detection via unified service (async path).
            async with get_async_detection_db_session() as db:
                service = get_async_gateway_integration_service(db)
                output_result = await service.process_output(
                    application_id=application_id,
                    tenant_id=tenant_id,
                    content=combined_content,
                    restore_mapping=restore_mapping,
                    input_messages=input_messages,
                    source="proxy",
                )

            output_action = output_result.get("action", "pass")
            output_detection_id = output_result.get("detection_result", {}).get("detection_id")

            if output_action == "block":
                output_blocked = True
                # Use suggest_answer from detection result
                block_message = output_result.get("detection_result", {}).get("suggest_answer")
                if not block_message:
                    block_response = output_result.get("block_response", {})
                    if block_response.get("body"):
                        try:
                            body = json.loads(block_response["body"])
                            block_message = body.get("choices", [{}])[0].get("message", {}).get("content", "")
                        except Exception:
                            pass
                if not block_message:
                    block_message = "Response blocked by OpenGuardrails due to policy violation."
                message['content'] = block_message
                if 'tool_calls' in message:
                    del message['tool_calls']
                upstream_response['choices'][0]['finish_reason'] = 'stop'

            elif output_action == "restore":
                # Restored content from service
                restored = output_result.get("restored_content", output_content)
                if output_content:
                    upstream_response['choices'][0]['message']['content'] = restored

            elif output_action == "anonymize":
                # Anonymized output content
                anonymized = output_result.get("anonymized_content", output_content)
                if output_content:
                    upstream_response['choices'][0]['message']['content'] = anonymized

            else:
                # pass - no changes needed, but still restore if we have mapping
                if restore_mapping and output_content:
                    from services.request_context import restore_placeholders
                    restored = restore_placeholders(output_content)
                    upstream_response['choices'][0]['message']['content'] = restored

        # Extract usage tokens
        usage = upstream_response.get('usage', {})

        # Log request
        await proxy_service.log_proxy_request_gateway(
            request_id=request_id,
            tenant_id=tenant_id,
            upstream_api_config_id=str(api_config.id),
            model_requested=model_name,
            model_used=model_name,
            provider=api_config.provider or "unknown",
            input_detection_id=input_detection_id,
            output_detection_id=output_detection_id,
            input_blocked=False,
            output_blocked=output_blocked,
            request_tokens=usage.get('prompt_tokens', 0),
            response_tokens=usage.get('completion_tokens', 0),
            total_tokens=usage.get('total_tokens', 0),
            status="success",
            response_time_ms=int((time.time() - start_time) * 1000)
        )

        return JSONResponse(content=upstream_response)

    except Exception as e:
        logger.error(f"Gateway non-streaming handler error: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": {"message": str(e), "type": "internal_error"}}
        )


# ============================================================================
# Helper Functions
# ============================================================================

def _extract_chunk_content(chunk: dict, content_field: str = "content") -> str:
    """Extract content from SSE chunk, support different content fields"""
    try:
        if 'choices' in chunk and chunk['choices']:
            choice = chunk['choices'][0]
            if 'delta' in choice:
                if content_field in choice['delta']:
                    return choice['delta'][content_field] or ""
                elif 'content' in choice['delta']:
                    return choice['delta']['content'] or ""
    except Exception:
        pass
    return ""


def _create_content_chunk(request_id: str, content: str, model: str = "openguardrails-security") -> dict:
    """Create a content chunk with specified content"""
    return {
        "id": f"chatcmpl-{request_id}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{
            "index": 0,
            "delta": {"content": content}
        }]
    }


def _create_error_chunk(request_id: str, error_msg: str, model: str = "openguardrails-security") -> dict:
    """Create error chunk"""
    return {
        "id": f"chatcmpl-{request_id}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{
            "index": 0,
            "delta": {"content": f"\n\n[Error: {error_msg}]"},
            "finish_reason": "stop"
        }]
    }


def _yield_suggest_answer_chunks(request_id: str, suggest_answer: str, model: str = "openguardrails-security", chunk_size: int = 50):
    """Yield suggest answer content in chunks to match streaming format"""
    if not suggest_answer:
        return
    for i in range(0, len(suggest_answer), chunk_size):
        chunk_content = suggest_answer[i:i + chunk_size]
        content_chunk = _create_content_chunk(request_id, chunk_content, model)
        yield f"data: {json.dumps(content_chunk)}\n\n"


def get_provider_from_url(api_base_url: str) -> str:
    """Infer provider name from API base URL"""
    try:
        if '//' in api_base_url:
            domain = api_base_url.split('//')[1].split('/')[0].split('.')[0]
            return domain
        return "unknown"
    except:
        return "unknown"


# ============================================================================
# Request Models
# ============================================================================

class OpenAIMessage(BaseModel):
    role: str
    content: Union[str, List[Dict[str, Any]], None] = None
    name: Optional[str] = None
    tool_calls: Optional[List[Dict[str, Any]]] = None
    tool_call_id: Optional[str] = None

class ChatCompletionRequest(BaseModel):
    model: str
    messages: List[OpenAIMessage]
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    n: Optional[int] = 1
    stream: Optional[bool] = False
    stop: Optional[Union[str, List[str]]] = None
    max_tokens: Optional[int] = None
    presence_penalty: Optional[float] = None
    frequency_penalty: Optional[float] = None
    logit_bias: Optional[Dict[str, int]] = None
    user: Optional[str] = None
    extra_body: Optional[Dict[str, Any]] = None

    class Config:
        extra = "allow"

class CompletionRequest(BaseModel):
    model: str
    prompt: Union[str, List[str]]
    temperature: Optional[float] = None
    top_p: Optional[float] = None
    n: Optional[int] = 1
    stream: Optional[bool] = False
    logprobs: Optional[int] = None
    echo: Optional[bool] = False
    stop: Optional[Union[str, List[str]]] = None
    max_tokens: Optional[int] = None
    presence_penalty: Optional[float] = None
    frequency_penalty: Optional[float] = None
    best_of: Optional[int] = None
    logit_bias: Optional[Dict[str, int]] = None
    user: Optional[str] = None
    extra_body: Optional[Dict[str, Any]] = None

    class Config:
        extra = "allow"


# ============================================================================
# API Endpoints
# ============================================================================

@router.get("/v1/models")
async def list_models(request: Request):
    """List models configured for tenant via model routes"""
    try:
        auth_ctx = getattr(request.state, 'auth_context', None)
        if not auth_ctx:
            raise HTTPException(status_code=401, detail="Authentication required")

        tenant_id = auth_ctx['data'].get('tenant_id')
        application_id = auth_ctx['data'].get('application_id')

        # Phase 3: async path. `route.route_applications` and
        # `route.upstream_api_config` are eager-loaded by the async
        # service method (selectinload).
        async with get_async_admin_db_session() as db:
            routes = await model_route_service.get_routes_for_tenant_async(db, tenant_id)

            seen_patterns = set()
            model_list = []
            for route in routes:
                has_app_bindings = len(route.route_applications) > 0
                if has_app_bindings and application_id:
                    app_uuid = uuid.UUID(application_id)
                    if not any(b.application_id == app_uuid for b in route.route_applications):
                        continue
                elif has_app_bindings:
                    continue

                pattern = route.model_pattern
                if pattern in seen_patterns:
                    continue
                seen_patterns.add(pattern)

                upstream = route.upstream_api_config
                owned_by = "unknown"
                if upstream and upstream.provider:
                    owned_by = upstream.provider
                elif upstream and upstream.api_base_url and '//' in upstream.api_base_url:
                    owned_by = upstream.api_base_url.split('//')[1].split('.')[0]

                model_list.append({
                    "id": pattern,
                    "object": "model",
                    "created": int(route.created_at.timestamp()),
                    "owned_by": owned_by,
                    "permission": [],
                    "root": pattern,
                    "parent": None,
                })

        return {
            "object": "list",
            "data": model_list
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"List models error: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": {"message": str(e), "type": "internal_error"}}
        )


async def _get_default_application_id(tenant_id: str) -> Optional[str]:
    """Find default application for tenant if application_id not in auth context.

    Phase 3: async helper — opens its own AsyncSession. Called from
    `chat_completions` and `completions` endpoints when the auth context
    didn't carry an `application_id` (e.g., tenant-scoped API key)."""
    try:
        from database.models import Application
        import uuid as uuid_module

        async with get_async_admin_db_session() as db:
            tenant_uuid = uuid_module.UUID(str(tenant_id))
            res = await db.execute(
                select(Application.id)
                .where(
                    Application.tenant_id == tenant_uuid,
                    Application.is_active == True,  # noqa: E712
                )
                .order_by(Application.created_at.asc())
                .limit(1)
            )
            default_app_id = res.scalar_one_or_none()
            if default_app_id:
                return str(default_app_id)
    except (ValueError, Exception) as e:
        logger.warning(f"Failed to find default application for tenant {tenant_id}: {e}")
    return None


@router.post("/v1/chat/completions")
async def create_chat_completion(
    request_data: ChatCompletionRequest,
    request: Request
):
    """Create chat completion with automatic model routing.

    Uses GatewayIntegrationService for unified detection (same as Higress/LiteLLM).
    """
    try:
        auth_ctx = getattr(request.state, 'auth_context', None)
        if not auth_ctx:
            raise HTTPException(status_code=401, detail="Authentication required")

        tenant_id = auth_ctx['data'].get('tenant_id')
        application_id = auth_ctx['data'].get('application_id')

        if not application_id and tenant_id:
            application_id = await _get_default_application_id(tenant_id)
            if application_id:
                logger.debug(f"Using default application {application_id} for tenant {tenant_id}")

        request_id = str(uuid.uuid4())

        # Get user ID
        user_id = None
        if request_data.extra_body:
            user_id = request_data.extra_body.get('xxai_app_user_id')
        if not user_id:
            user_id = tenant_id

        logger.info(f"Chat completion request {request_id} from tenant {tenant_id}, "
                     f"application {application_id} for model {request_data.model}, user_id: {user_id}")

        # Check for image detection subscription if images are present
        has_images = False
        for msg in request_data.messages:
            content = msg.content
            if isinstance(content, list):
                for part in content:
                    if hasattr(part, 'type') and part.type == 'image_url':
                        has_images = True
                        break

        if has_images:
            subscription = billing_service.get_subscription(tenant_id, None)
            if not subscription:
                return JSONResponse(
                    status_code=403,
                    content={"error": {"message": "Subscription not found. Please contact support to enable image detection.", "type": "subscription_required"}}
                )
            if subscription.subscription_type != 'subscribed':
                return JSONResponse(
                    status_code=403,
                    content={"error": {"message": "Image detection is only available for subscribed users.", "type": "subscription_required"}}
                )

        # Get upstream API config via model routing (async path).
        async with get_async_admin_db_session() as db:
            model_config = await model_route_service.find_matching_route_async(
                db=db,
                tenant_id=tenant_id,
                model_name=request_data.model,
                application_id=application_id,
            )

        if not model_config:
            return JSONResponse(
                status_code=404,
                content={"error": {"message": f"No routing rule configured for model '{request_data.model}'.", "type": "model_route_not_found"}}
            )

        logger.info(f"Model routing: '{request_data.model}' -> upstream config '{model_config.config_name}'")

        # Construct messages for detection
        input_messages = []
        for msg in request_data.messages:
            m = {"role": msg.role, "content": msg.content}
            if getattr(msg, 'tool_calls', None):
                m['tool_calls'] = msg.tool_calls
            if getattr(msg, 'tool_call_id', None):
                m['tool_call_id'] = msg.tool_call_id
            if getattr(msg, 'name', None):
                m['name'] = msg.name
            input_messages.append(m)

        start_time = time.time()
        input_blocked = False
        output_blocked = False
        input_detection_id = None

        try:
            # ============ Input Detection via GatewayIntegrationService ============
            async with get_async_detection_db_session() as db:
                service = get_async_gateway_integration_service(db)
                input_result = await service.process_input(
                    application_id=application_id or "",
                    tenant_id=tenant_id,
                    messages=input_messages,
                    stream=request_data.stream or False,
                    user_id=user_id,
                    source="proxy",
                )

            input_action = input_result.get("action", "pass")
            input_detection_id = input_result.get("detection_id") or input_result.get("request_id")
            restore_mapping = None

            # ============ Handle Input Detection Results ============
            if input_action == "block":
                input_blocked = True
                # Extract block message
                block_response = input_result.get("block_response", {})
                suggest_answer = "Request blocked by OpenGuardrails."
                if block_response.get("body"):
                    try:
                        body = json.loads(block_response["body"])
                        suggest_answer = body.get("choices", [{}])[0].get("message", {}).get("content", suggest_answer)
                    except Exception:
                        pass

                # Also try from detection_result
                dr = input_result.get("detection_result", {})
                if dr.get("suggest_answer"):
                    suggest_answer = dr["suggest_answer"]

                logger.warning(f"[InputBlocked] request_id={request_id}, action={input_action}")

                await proxy_service.log_proxy_request_gateway(
                    request_id=request_id,
                    tenant_id=tenant_id,
                    upstream_api_config_id=str(model_config.id),
                    model_requested=request_data.model,
                    model_used=request_data.model,
                    provider=model_config.provider or "unknown",
                    input_detection_id=input_detection_id,
                    input_blocked=True,
                    status="blocked",
                    response_time_ms=int((time.time() - start_time) * 1000)
                )

                if request_data.stream:
                    async def blocked_stream_generator():
                        blocked_chunk = {
                            "id": f"chatcmpl-{request_id}",
                            "object": "chat.completion.chunk",
                            "created": int(time.time()),
                            "model": request_data.model,
                            "choices": [{
                                "index": 0,
                                "delta": {"content": suggest_answer},
                                "finish_reason": "stop"
                            }]
                        }
                        yield f"data: {json.dumps(blocked_chunk)}\n\n"
                        yield "data: [DONE]\n\n"

                    return StreamingResponse(
                        blocked_stream_generator(),
                        media_type="text/event-stream",
                        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
                    )

                return {
                    "id": f"chatcmpl-{request_id}",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": request_data.model,
                    "choices": [{
                        "index": 0,
                        "message": {"role": "assistant", "content": suggest_answer},
                        "finish_reason": "stop"
                    }],
                    "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
                }

            elif input_action == "replace":
                input_blocked = True
                replace_response = input_result.get("replace_response", {})
                suggest_answer = "Request blocked by OpenGuardrails."
                if replace_response.get("body"):
                    try:
                        body = json.loads(replace_response["body"])
                        suggest_answer = body.get("choices", [{}])[0].get("message", {}).get("content", suggest_answer)
                    except Exception:
                        pass
                dr = input_result.get("detection_result", {})
                if dr.get("suggest_answer"):
                    suggest_answer = dr["suggest_answer"]

                await proxy_service.log_proxy_request_gateway(
                    request_id=request_id,
                    tenant_id=tenant_id,
                    upstream_api_config_id=str(model_config.id),
                    model_requested=request_data.model,
                    model_used=request_data.model,
                    provider=model_config.provider or "unknown",
                    input_detection_id=input_detection_id,
                    input_blocked=True,
                    status="blocked",
                    response_time_ms=int((time.time() - start_time) * 1000)
                )

                if request_data.stream:
                    async def replace_stream_generator():
                        for chunk_str in _yield_suggest_answer_chunks(request_id, suggest_answer, request_data.model):
                            yield chunk_str
                        stop_chunk = {
                            "id": f"chatcmpl-{request_id}",
                            "object": "chat.completion.chunk",
                            "created": int(time.time()),
                            "model": request_data.model,
                            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]
                        }
                        yield f"data: {json.dumps(stop_chunk)}\n\n"
                        yield "data: [DONE]\n\n"

                    return StreamingResponse(
                        replace_stream_generator(),
                        media_type="text/event-stream",
                        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"}
                    )

                return {
                    "id": f"chatcmpl-{request_id}",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": request_data.model,
                    "choices": [{
                        "index": 0,
                        "message": {"role": "assistant", "content": suggest_answer},
                        "finish_reason": "stop"
                    }],
                    "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
                }

            # ============ Determine actual messages and model config ============
            actual_messages = input_messages
            actual_model_config = model_config
            actual_model_name = request_data.model

            if input_action == "anonymize":
                actual_messages = input_result.get("anonymized_messages", input_messages)
                restore_mapping = input_result.get("restore_mapping")
                logger.info(f"Input anonymized, restore_mapping entries: {len(restore_mapping) if restore_mapping else 0}")

            elif input_action == "switch_private_model":
                private_model_config = input_result.get("modified_model_config")
                if private_model_config:
                    actual_model_config = private_model_config
                    if actual_model_config.default_private_model_name:
                        actual_model_name = actual_model_config.default_private_model_name
                    logger.info(f"Switched to private model: {actual_model_config.config_name}, model: {actual_model_name}")

            # Clean messages for upstream
            clean_messages = []
            for msg in actual_messages:
                if isinstance(msg, dict):
                    clean_msg = {"role": msg.get('role'), "content": msg.get('content')}
                    if msg.get('tool_calls'):
                        clean_msg['tool_calls'] = msg['tool_calls']
                    if msg.get('tool_call_id'):
                        clean_msg['tool_call_id'] = msg['tool_call_id']
                    if msg.get('name'):
                        clean_msg['name'] = msg['name']
                else:
                    clean_msg = {"role": msg.role, "content": msg.content}
                    if getattr(msg, 'tool_calls', None):
                        clean_msg['tool_calls'] = msg.tool_calls
                    if getattr(msg, 'tool_call_id', None):
                        clean_msg['tool_call_id'] = msg.tool_call_id
                    if getattr(msg, 'name', None):
                        clean_msg['name'] = msg.name
                clean_messages.append(clean_msg)

            # ============ Forward to Upstream ============
            if request_data.stream:
                upstream_response = await proxy_service.call_upstream_api_gateway(
                    api_config=actual_model_config,
                    model_name=actual_model_name,
                    messages=clean_messages,
                    stream=True,
                    temperature=request_data.temperature,
                    max_tokens=request_data.max_tokens,
                    top_p=request_data.top_p,
                    frequency_penalty=request_data.frequency_penalty,
                    presence_penalty=request_data.presence_penalty,
                    stop=request_data.stop,
                    extra_body=request_data.extra_body,
                    tools=getattr(request_data, 'tools', None),
                    tool_choice=getattr(request_data, 'tool_choice', None)
                )
                return await _handle_gateway_streaming_response(
                    upstream_response, actual_model_config, tenant_id, request_id,
                    input_detection_id, user_id, request_data.model, start_time,
                    input_messages, application_id,
                    restore_mapping=restore_mapping
                )

            # Non-streaming
            model_response = await proxy_service.call_upstream_api_gateway(
                api_config=actual_model_config,
                model_name=actual_model_name,
                messages=clean_messages,
                stream=False,
                temperature=request_data.temperature,
                max_tokens=request_data.max_tokens,
                top_p=request_data.top_p,
                frequency_penalty=request_data.frequency_penalty,
                presence_penalty=request_data.presence_penalty,
                stop=request_data.stop,
                extra_body=request_data.extra_body,
                tools=getattr(request_data, 'tools', None),
                tool_choice=getattr(request_data, 'tool_choice', None)
            )

            return await _handle_gateway_non_streaming_response(
                model_response, actual_model_config, tenant_id, request_id,
                input_detection_id, user_id, request_data.model, start_time,
                input_messages, application_id,
                restore_mapping=restore_mapping
            )

        except Exception as e:
            import traceback
            logger.error(f"Proxy request {request_id} failed: {e}\n{traceback.format_exc()}")

            await proxy_service.log_proxy_request_gateway(
                request_id=request_id,
                tenant_id=tenant_id,
                upstream_api_config_id=str(model_config.id),
                model_requested=request_data.model,
                model_used=request_data.model,
                provider=model_config.provider or "unknown",
                input_detection_id=input_detection_id,
                input_blocked=input_blocked,
                output_blocked=output_blocked,
                status="error",
                error_message=str(e),
                response_time_ms=int((time.time() - start_time) * 1000)
            )

            return JSONResponse(
                status_code=500,
                content={"error": {"message": "Failed to process request", "type": "api_error"}}
            )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Chat completion error: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": {"message": str(e), "type": "internal_error"}}
        )


@router.post("/v1/completions")
async def create_completion(
    request_data: CompletionRequest,
    request: Request
):
    """Create text completion (compatible with old OpenAI API).
    Uses GatewayIntegrationService for unified detection."""
    try:
        auth_ctx = getattr(request.state, 'auth_context', None)
        if not auth_ctx:
            raise HTTPException(status_code=401, detail="Authentication required")

        tenant_id = auth_ctx['data'].get('tenant_id')
        application_id = auth_ctx['data'].get('application_id')

        if not application_id and tenant_id:
            application_id = await _get_default_application_id(tenant_id)

        request_id = str(uuid.uuid4())

        user_id = None
        if request_data.extra_body:
            user_id = request_data.extra_body.get('xxai_app_user_id')
        if not user_id:
            user_id = tenant_id

        logger.info(f"Completion request {request_id} from tenant {tenant_id}, application {application_id}")

        # Get tenant's model configuration
        model_config = await proxy_service.get_user_model_config(tenant_id, request_data.model)
        if not model_config:
            return JSONResponse(
                status_code=404,
                content={"error": {"message": f"Model '{request_data.model}' not found.", "type": "model_not_found"}}
            )

        # Process prompt
        if isinstance(request_data.prompt, str):
            prompt_text = request_data.prompt
        else:
            prompt_text = "\n".join(request_data.prompt)

        input_messages = [{"role": "user", "content": prompt_text}]

        start_time = time.time()
        input_blocked = False
        input_detection_id = None

        try:
            # Input detection via unified service (async path).
            async with get_async_detection_db_session() as db:
                service = get_async_gateway_integration_service(db)
                input_result = await service.process_input(
                    application_id=application_id or "",
                    tenant_id=tenant_id,
                    messages=input_messages,
                    stream=False,
                    user_id=user_id,
                    source="proxy",
                )

            input_action = input_result.get("action", "pass")
            input_detection_id = input_result.get("detection_id") or input_result.get("request_id")

            if input_action in ("block", "replace"):
                input_blocked = True
                suggest_answer = "Request blocked by OpenGuardrails."
                response_key = "block_response" if input_action == "block" else "replace_response"
                resp = input_result.get(response_key, {})
                if resp.get("body"):
                    try:
                        body = json.loads(resp["body"])
                        suggest_answer = body.get("choices", [{}])[0].get("message", {}).get("content", suggest_answer)
                    except Exception:
                        pass
                dr = input_result.get("detection_result", {})
                if dr.get("suggest_answer"):
                    suggest_answer = dr["suggest_answer"]

                await proxy_service.log_proxy_request(
                    request_id=request_id,
                    tenant_id=tenant_id,
                    proxy_config_id=str(model_config.id),
                    model_requested=request_data.model,
                    model_used=model_config.model_name,
                    provider=get_provider_from_url(model_config.api_base_url),
                    input_detection_id=input_detection_id,
                    input_blocked=True,
                    status="blocked",
                    response_time_ms=int((time.time() - start_time) * 1000)
                )

                return {
                    "id": f"cmpl-{request_id}",
                    "object": "text_completion",
                    "created": int(time.time()),
                    "model": request_data.model,
                    "choices": [{"text": suggest_answer, "index": 0, "logprobs": None, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
                }

            # Forward request
            model_response = await proxy_service.forward_completion(
                model_config=model_config,
                request_data=request_data,
                request_id=request_id
            )

            # Output detection
            if model_response.get('choices'):
                output_text = model_response['choices'][0]['text']

                async with get_async_detection_db_session() as db:
                    service = get_async_gateway_integration_service(db)
                    output_result = await service.process_output(
                        application_id=application_id or "",
                        tenant_id=tenant_id,
                        content=output_text,
                        input_messages=input_messages,
                        source="proxy",
                    )

                output_action = output_result.get("action", "pass")
                if output_action == "block":
                    block_msg = "Response blocked by OpenGuardrails."
                    br = output_result.get("block_response", {})
                    if br.get("body"):
                        try:
                            body = json.loads(br["body"])
                            block_msg = body.get("choices", [{}])[0].get("message", {}).get("content", block_msg)
                        except Exception:
                            pass
                    model_response['choices'][0]['text'] = block_msg
                    model_response['choices'][0]['finish_reason'] = 'stop'
                elif output_action == "restore":
                    model_response['choices'][0]['text'] = output_result.get("restored_content", output_text)
                elif output_action == "anonymize":
                    model_response['choices'][0]['text'] = output_result.get("anonymized_content", output_text)

            # Log
            usage = model_response.get('usage', {})
            await proxy_service.log_proxy_request(
                request_id=request_id,
                tenant_id=tenant_id,
                proxy_config_id=str(model_config.id),
                model_requested=request_data.model,
                model_used=model_config.model_name,
                provider=get_provider_from_url(model_config.api_base_url),
                input_detection_id=input_detection_id,
                input_blocked=input_blocked,
                request_tokens=usage.get('prompt_tokens', 0),
                response_tokens=usage.get('completion_tokens', 0),
                total_tokens=usage.get('total_tokens', 0),
                status="success",
                response_time_ms=int((time.time() - start_time) * 1000)
            )

            return model_response

        except Exception as e:
            import traceback
            logger.error(f"Proxy request {request_id} failed: {e}\n{traceback.format_exc()}")

            await proxy_service.log_proxy_request(
                request_id=request_id,
                tenant_id=tenant_id,
                proxy_config_id=str(model_config.id),
                model_requested=request_data.model,
                model_used=model_config.model_name,
                provider=get_provider_from_url(model_config.api_base_url),
                input_detection_id=input_detection_id,
                input_blocked=input_blocked,
                status="error",
                error_message=str(e),
                response_time_ms=int((time.time() - start_time) * 1000)
            )

            return JSONResponse(
                status_code=500,
                content={"error": {"message": "Failed to process request", "type": "api_error"}}
            )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Completion error: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": {"message": str(e), "type": "internal_error"}}
        )
