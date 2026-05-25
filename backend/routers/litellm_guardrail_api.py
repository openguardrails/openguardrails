"""
LiteLLM Generic Guardrail API Adapter

Implements LiteLLM's Generic Guardrail API specification (/beta/litellm_basic_guardrail_api)
to allow LiteLLM users to use OpenGuardrails without a native integration PR.

This is Step 1 of the two-step LiteLLM integration:
- Step 1 (this): Generic API adapter - works immediately, no LiteLLM PR needed
- Step 2: Native integration - full feature support, requires LiteLLM PR

Limitations of Generic API (vs Native Integration):
- No private model switching (switch_private_model → falls back to block)
- No anonymization + restoration (no session state between input/output)
- No streaming placeholder restoration
- No bypass token mechanism
- replace action → BLOCKED (cannot return custom response as 200)

See: integrations/og-connector-litellm/README.md for full documentation.
"""

from fastapi import APIRouter, HTTPException, Request, Depends
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import Dict, Any, Optional, List, Literal
import time

from database.connection import get_db
from sqlalchemy.orm import Session
from services.gateway_integration_service import get_gateway_integration_service
from utils.logger import setup_logger

router = APIRouter(tags=["LiteLLM Generic Guardrail API"])
logger = setup_logger()


class LiteLLMGuardrailRequest(BaseModel):
    """LiteLLM Generic Guardrail API request format"""
    texts: Optional[List[str]] = Field(default=None, description="Extracted text strings to check")
    images: Optional[List[str]] = Field(default=None, description="Base64 encoded images")
    tools: Optional[List[Dict[str, Any]]] = Field(default=None, description="Tool definitions")
    tool_calls: Optional[List[Dict[str, Any]]] = Field(default=None, description="Tool call invocations")
    structured_messages: Optional[List[Dict[str, Any]]] = Field(
        default=None, description="Full OpenAI-format messages array"
    )
    request_data: Optional[Dict[str, Any]] = Field(default=None, description="User API key metadata")
    request_headers: Optional[Dict[str, str]] = Field(default=None, description="Sanitized inbound headers")
    input_type: Literal["request", "response"] = Field(
        default="request", description="Whether this is input or output guardrail"
    )
    litellm_call_id: Optional[str] = Field(default=None, description="Unique call identifier")
    litellm_trace_id: Optional[str] = Field(default=None, description="Trace identifier")
    litellm_version: Optional[str] = Field(default=None, description="LiteLLM version")
    additional_provider_specific_params: Optional[Dict[str, Any]] = Field(
        default=None, description="Extra params from guardrail config"
    )
    model: Optional[str] = Field(default=None, description="Model being used")


class LiteLLMGuardrailResponse(BaseModel):
    """LiteLLM Generic Guardrail API response format"""
    action: Literal["BLOCKED", "NONE", "GUARDRAIL_INTERVENED"] = Field(
        description="Guardrail action"
    )
    blocked_reason: Optional[str] = Field(default=None, description="Reason for blocking")
    texts: Optional[List[str]] = Field(default=None, description="Modified texts if intervened")
    images: Optional[List[str]] = Field(default=None, description="Modified images if intervened")


def _extract_messages_from_request(body: LiteLLMGuardrailRequest) -> List[Dict[str, Any]]:
    """
    Extract OpenAI-format messages from LiteLLM request.
    Prefers structured_messages (full format), falls back to texts.
    """
    if body.structured_messages:
        return body.structured_messages

    if body.texts:
        # Wrap texts as user messages
        return [{"role": "user", "content": text} for text in body.texts]

    return []


def _extract_content_from_request(body: LiteLLMGuardrailRequest) -> str:
    """Extract text content for output detection."""
    if body.texts:
        return "\n".join(body.texts)
    return ""


def _og_action_to_litellm_response(
    og_result: Dict[str, Any],
    input_type: str
) -> LiteLLMGuardrailResponse:
    """
    Map OG gateway action to LiteLLM Generic Guardrail API response.

    OG actions → LiteLLM actions:
    - block → BLOCKED
    - replace → BLOCKED (generic API cannot return custom 200 response)
    - anonymize → GUARDRAIL_INTERVENED (return anonymized texts)
    - switch_private_model → BLOCKED (generic API cannot switch models)
    - pass → NONE
    - restore → GUARDRAIL_INTERVENED (return restored texts)
    """
    action = og_result.get("action", "pass")
    detection = og_result.get("detection_result", {})
    risk_level = detection.get("overall_risk_level", "no_risk")

    if action == "block":
        # Extract block reason from detection result
        block_resp = og_result.get("block_response", {})
        block_body = block_resp.get("body", "")
        reason = f"OpenGuardrails: Content blocked (risk_level={risk_level})"
        if block_body:
            try:
                import json
                body_json = json.loads(block_body)
                msg = body_json.get("choices", [{}])[0].get("message", {}).get("content", "")
                if msg:
                    reason = msg
            except (json.JSONDecodeError, IndexError, KeyError):
                pass
        return LiteLLMGuardrailResponse(action="BLOCKED", blocked_reason=reason)

    elif action == "replace":
        # Generic API cannot return replacement content as 200, so we block
        replace_resp = og_result.get("replace_response", {})
        replace_body = replace_resp.get("body", "")
        reason = f"OpenGuardrails: Content replaced (risk_level={risk_level})"
        if replace_body:
            try:
                import json
                body_json = json.loads(replace_body)
                msg = body_json.get("choices", [{}])[0].get("message", {}).get("content", "")
                if msg:
                    reason = msg
            except (json.JSONDecodeError, IndexError, KeyError):
                pass
        return LiteLLMGuardrailResponse(action="BLOCKED", blocked_reason=reason)

    elif action == "anonymize":
        # Return anonymized messages as modified texts
        anonymized_messages = og_result.get("anonymized_messages", [])
        if anonymized_messages:
            texts = []
            for msg in anonymized_messages:
                content = msg.get("content", "")
                if isinstance(content, str) and content:
                    texts.append(content)
            if texts:
                return LiteLLMGuardrailResponse(
                    action="GUARDRAIL_INTERVENED",
                    texts=texts
                )
        return LiteLLMGuardrailResponse(action="NONE")

    elif action == "switch_private_model":
        # Generic API cannot switch models - fall back to block
        return LiteLLMGuardrailResponse(
            action="BLOCKED",
            blocked_reason=(
                "OpenGuardrails: Sensitive data detected, private model switch required. "
                "This feature requires the native OpenGuardrails integration. "
                "See: https://github.com/openguardrails/openguardrails/tree/main/integrations/og-connector-litellm"
            )
        )

    elif action == "proxy_response":
        # OG proxied to private model - extract the response content
        proxy_resp = og_result.get("proxy_response", {})
        proxy_body = proxy_resp.get("body", "")
        if proxy_body:
            try:
                import json
                body_json = json.loads(proxy_body)
                content = body_json.get("choices", [{}])[0].get("message", {}).get("content", "")
                if content:
                    return LiteLLMGuardrailResponse(
                        action="GUARDRAIL_INTERVENED",
                        texts=[content]
                    )
            except (json.JSONDecodeError, IndexError, KeyError):
                pass
        return LiteLLMGuardrailResponse(action="NONE")

    elif action in ("restore", "pass"):
        if action == "restore":
            restored = og_result.get("restored_content", "")
            if restored:
                return LiteLLMGuardrailResponse(
                    action="GUARDRAIL_INTERVENED",
                    texts=[restored]
                )
        return LiteLLMGuardrailResponse(action="NONE")

    # Default: pass through
    return LiteLLMGuardrailResponse(action="NONE")


def _get_auth_from_request(request: Request) -> Dict[str, str]:
    """Extract tenant_id and application_id from auth context."""
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context:
        raise HTTPException(
            status_code=401,
            detail={"error": {"message": "Authentication required", "type": "authentication_error"}}
        )
    data = auth_context.get('data', {})
    tenant_id = data.get('tenant_id')
    application_id = data.get('application_id')
    if not tenant_id or not application_id:
        raise HTTPException(
            status_code=401,
            detail={"error": {"message": "Invalid API key - must use application API key", "type": "authentication_error"}}
        )
    return {"tenant_id": tenant_id, "application_id": application_id}


@router.post("/beta/litellm_basic_guardrail_api")
async def litellm_generic_guardrail(
    request: Request,
    body: LiteLLMGuardrailRequest,
    db: Session = Depends(get_db)
):
    """
    LiteLLM Generic Guardrail API endpoint.

    Implements the LiteLLM Generic Guardrail API specification to enable
    OpenGuardrails integration without a native LiteLLM PR.

    Authentication: Bearer sk-xxai-xxx (application API key)

    LiteLLM config.yaml example:
        guardrails:
          - guardrail_name: "openguardrails"
            litellm_params:
              guardrail: generic_guardrail_api
              mode: [pre_call, post_call]
              api_base: http://og-server:5001
              api_key: sk-xxai-your-key
              unreachable_fallback: fail_open
    """
    start_time = time.time()

    auth_info = _get_auth_from_request(request)
    tenant_id = auth_info["tenant_id"]
    application_id = auth_info["application_id"]

    service = get_gateway_integration_service(db)

    logger.info(
        f"LiteLLM guardrail: input_type={body.input_type}, "
        f"texts_count={len(body.texts) if body.texts else 0}, "
        f"msgs_count={len(body.structured_messages) if body.structured_messages else 0}, "
        f"call_id={body.litellm_call_id}"
    )

    if body.input_type == "request":
        # Input detection
        messages = _extract_messages_from_request(body)
        if not messages:
            return JSONResponse(content=LiteLLMGuardrailResponse(action="NONE").model_dump())

        og_result = await service.process_input(
            application_id=application_id,
            tenant_id=tenant_id,
            messages=messages,
            stream=False,
            client_ip=None,
            user_id=body.request_data.get("user_api_key_user_id") if body.request_data else None,
            source="gateway"
        )

    else:
        # Output detection
        content = _extract_content_from_request(body)
        if not content:
            return JSONResponse(content=LiteLLMGuardrailResponse(action="NONE").model_dump())

        # For output, also pass input messages as context if available
        input_messages = None
        if body.structured_messages:
            input_messages = body.structured_messages

        og_result = await service.process_output(
            application_id=application_id,
            tenant_id=tenant_id,
            content=content,
            session_id=None,
            restore_mapping=None,
            is_streaming=False,
            chunk_index=0,
            input_messages=input_messages,
            source="gateway"
        )

    # Convert OG result to LiteLLM response format
    litellm_response = _og_action_to_litellm_response(og_result, body.input_type)

    processing_time = round((time.time() - start_time) * 1000, 2)
    logger.info(
        f"LiteLLM guardrail: app={application_id[:8]}..., "
        f"input_type={body.input_type}, "
        f"og_action={og_result.get('action')}, "
        f"litellm_action={litellm_response.action}, "
        f"time={processing_time}ms"
    )

    return JSONResponse(content=litellm_response.model_dump())
