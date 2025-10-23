from fastapi import APIRouter, Depends, Request, HTTPException
from sqlalchemy.orm import Session
from database.connection import get_db
from services.guardrail_service import GuardrailService
from models.requests import DifyModerationRequest, GuardrailRequest, Message
from models.responses import DifyModerationResponse
from utils.logger import setup_logger

logger = setup_logger()
router = APIRouter(tags=["Dify Moderation"])


@router.post("/dify/moderation", response_model=DifyModerationResponse)
async def dify_moderation(
    request_data: DifyModerationRequest,
    request: Request,
    db: Session = Depends(get_db)
):
    """
    Dify API-based Extension Moderation Endpoint

    Supports three extension points:
    - ping: Health check
    - app.moderation.input: Moderate user inputs (variables + query)
    - app.moderation.output: Moderate LLM outputs

    Authentication: Uses Bearer token (API key from OpenGuardrails platform)
    """
    try:
        # Handle ping request
        if request_data.point == "ping":
            return DifyModerationResponse(result="pong")

        # Get tenant context from auth middleware
        auth_context = getattr(request.state, 'auth_context', None)
        tenant_id = None
        if auth_context:
            tenant_id = str(auth_context['data'].get('tenant_id') or auth_context['data'].get('tenant_id'))

        if not tenant_id:
            raise HTTPException(status_code=401, detail="Unauthorized: Valid API key required from OpenGuardrails platform")

        # Get client information
        ip_address = request.client.host if request.client else None
        user_agent = request.headers.get("user-agent")

        # Create guardrail service
        guardrail_service = GuardrailService(db)

        # Handle app.moderation.input
        if request_data.point == "app.moderation.input":
            return await handle_input_moderation(
                request_data,
                guardrail_service,
                tenant_id,
                ip_address,
                user_agent
            )

        # Handle app.moderation.output
        elif request_data.point == "app.moderation.output":
            return await handle_output_moderation(
                request_data,
                guardrail_service,
                tenant_id,
                ip_address,
                user_agent
            )

        else:
            raise HTTPException(status_code=400, detail=f"Unsupported extension point: {request_data.point}")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Dify moderation error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")


async def handle_input_moderation(
    request_data: DifyModerationRequest,
    guardrail_service: GuardrailService,
    tenant_id: str,
    ip_address: str,
    user_agent: str
) -> DifyModerationResponse:
    """
    Handle app.moderation.input

    Checks each variable in inputs and query independently.
    For input moderation:
    - Checks for compliance/security risks (prompt attacks, policy violations)
    - Checks for sensitive data in input (data leak detection with direction="input")

    Returns:
    - flagged=True if any check is not "pass"
    - action="direct_output" if any result is "reject" (high risk)
    - action="overridden" if no reject but has "replace" (medium/low risk or sensitive data found)
      - For sensitive data: replace with desensitized text that should be sent to LLM
      - For compliance/security: replace with preset safe response
    """
    params = request_data.params
    if not params:
        raise HTTPException(status_code=400, detail="Missing params for app.moderation.input")

    detection_results = []

    # Check each input variable
    if params.inputs:
        for var_name, var_value in params.inputs.items():
            if var_value and isinstance(var_value, str):
                result = await detect_prompt(
                    var_value,
                    guardrail_service,
                    tenant_id,
                    ip_address,
                    user_agent
                )
                detection_results.append({
                    'type': 'input',
                    'key': var_name,
                    'value': var_value,
                    'result': result
                })

    # Check query
    if params.query and isinstance(params.query, str):
        result = await detect_prompt(
            params.query,
            guardrail_service,
            tenant_id,
            ip_address,
            user_agent
        )
        detection_results.append({
            'type': 'query',
            'key': 'query',
            'value': params.query,
            'result': result
        })

    # Aggregate results
    return aggregate_input_results(detection_results, params)


async def handle_output_moderation(
    request_data: DifyModerationRequest,
    guardrail_service: GuardrailService,
    tenant_id: str,
    ip_address: str,
    user_agent: str
) -> DifyModerationResponse:
    """
    Handle app.moderation.output

    Checks LLM output with fixed prompt prefix.
    """
    params = request_data.params
    if not params or not params.text:
        raise HTTPException(status_code=400, detail="Missing text for app.moderation.output")

    # Use fixed prompt for response detection
    fixed_prompt = "The answer of the assistant is:"

    # Detect as response (assistant message)
    result = await detect_response(
        fixed_prompt,
        params.text,
        guardrail_service,
        tenant_id,
        ip_address,
        user_agent
    )

    # Build response based on detection result
    return aggregate_output_result(result, params.text)


async def detect_prompt(
    prompt: str,
    guardrail_service: GuardrailService,
    tenant_id: str,
    ip_address: str,
    user_agent: str
):
    """
    Detect a single prompt (user input)
    """
    guardrail_request = GuardrailRequest(
        model="OpenGuardrails-Text",
        messages=[
            Message(role="user", content=prompt)
        ]
    )

    result = await guardrail_service.check_guardrails(
        guardrail_request,
        ip_address=ip_address,
        user_agent=user_agent,
        tenant_id=tenant_id
    )

    return result


async def detect_response(
    prompt: str,
    response: str,
    guardrail_service: GuardrailService,
    tenant_id: str,
    ip_address: str,
    user_agent: str
):
    """
    Detect a response (assistant output)
    """
    guardrail_request = GuardrailRequest(
        model="OpenGuardrails-Text",
        messages=[
            Message(role="user", content=prompt),
            Message(role="assistant", content=response)
        ]
    )

    result = await guardrail_service.check_guardrails(
        guardrail_request,
        ip_address=ip_address,
        user_agent=user_agent,
        tenant_id=tenant_id
    )

    return result


def aggregate_input_results(detection_results: list, params) -> DifyModerationResponse:
    """
    Aggregate detection results for input moderation

    Logic:
    - flagged=True if any result is not "Pass"
    - action="direct_output" if any result is "Decline" (reject)
    - action="overridden" if no "Decline" but has "Delegate" (replace)
    """
    has_reject = False
    has_replace = False
    first_reject_answer = None

    overridden_inputs = {}
    overridden_query = None

    for item in detection_results:
        result = item['result']
        suggest_action = result.suggest_action

        # Check if this is a reject
        if suggest_action == "reject":
            has_reject = True
            if not first_reject_answer and result.suggest_answer:
                first_reject_answer = result.suggest_answer

        # Check if this is a replace
        elif suggest_action == "replace":
            has_replace = True

            # Store overridden value
            if item['type'] == 'input':
                overridden_inputs[item['key']] = result.suggest_answer if result.suggest_answer else item['value']
            elif item['type'] == 'query':
                overridden_query = result.suggest_answer if result.suggest_answer else item['value']

        # Pass action - keep original value
        else:
            if item['type'] == 'input':
                overridden_inputs[item['key']] = item['value']
            elif item['type'] == 'query':
                overridden_query = item['value']

    # Determine flagged status
    flagged = has_reject or has_replace

    # Build response
    if has_reject:
        # Direct output with preset response
        return DifyModerationResponse(
            flagged=True,
            action="direct_output",
            preset_response=first_reject_answer if first_reject_answer else "Your content violates our usage policy."
        )

    elif has_replace:
        # Override with modified inputs
        return DifyModerationResponse(
            flagged=True,
            action="overridden",
            inputs=overridden_inputs if params.inputs else None,
            query=overridden_query
        )

    else:
        # No issues detected
        return DifyModerationResponse(
            flagged=False
        )


def aggregate_output_result(result, original_text: str) -> DifyModerationResponse:
    """
    Aggregate detection result for output moderation

    Logic:
    - action="direct_output" if "reject" (high risk)
    - action="overridden" if "replace" (medium/low risk)
    - flagged=false if "pass" (no risk)
    """
    suggest_action = result.suggest_action

    if suggest_action == "reject":
        # Reject - return preset response
        return DifyModerationResponse(
            flagged=True,
            action="direct_output",
            preset_response=result.suggest_answer if result.suggest_answer else "Your content violates our usage policy."
        )

    elif suggest_action == "replace":
        # Replace - return overridden text
        return DifyModerationResponse(
            flagged=True,
            action="overridden",
            text=result.suggest_answer if result.suggest_answer else original_text
        )

    else:
        # Pass - no issues
        return DifyModerationResponse(
            flagged=False
        )
