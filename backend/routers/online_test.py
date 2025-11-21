from fastapi import APIRouter, Depends, Request, HTTPException
from pydantic import BaseModel
from pydantic import ConfigDict
from typing import List, Dict, Any, Optional
import asyncio
import uuid
import httpx
from sqlalchemy.orm import Session
from database.connection import get_admin_db, get_admin_db_session
from services.guardrail_service import GuardrailService
from models.requests import GuardrailRequest, Message
from database.models import Tenant
from utils.logger import setup_logger
from openai import AsyncOpenAI
from config import settings
from services.proxy_service import proxy_service

logger = setup_logger()
router = APIRouter(tags=["Online Test"])

class ModelConfig(BaseModel):
    id: str
    name: str
    base_url: str
    api_key: str
    model_name: str
    enabled: bool = True
    # Allow fields to start with model_
    model_config = ConfigDict(protected_namespaces=())

class ModelIdRequest(BaseModel):
    id: int
    enabled: bool = True

class OnlineTestRequest(BaseModel):
    content: str
    input_type: str  # 'question' or 'qa_pair'
    models: Optional[List[ModelIdRequest]] = []
    images: Optional[List[str]] = []  # base64 encoded image data list

class ModelResponse(BaseModel):
    content: Optional[str] = None
    error: Optional[str] = None

class OnlineTestResponse(BaseModel):
    guardrail: Dict[str, Any]
    models: Dict[str, ModelResponse] = {}
    original_responses: Dict[str, ModelResponse] = {}

class OnlineTestModelInfo(BaseModel):
    id: str
    config_name: str
    api_base_url: str
    provider: Optional[str] = None
    is_active: bool
    selected: bool = False  # Whether it is selected for online test
    model_name: Optional[str] = None  # Model name specified by user for testing

    # 允许以 model_ 开头的字段名
    model_config = ConfigDict(protected_namespaces=())

class UpdateModelSelectionRequest(BaseModel):
    model_selections: List[Dict[str, Any]]  # [{"id": "model_id", "selected": True/False, "model_name": "..."}]
    
    # Allow fields to start with model_
    model_config = ConfigDict(protected_namespaces=())

@router.get("/test/models", response_model=List[OnlineTestModelInfo])
async def get_online_test_models(
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Get available proxy models for online test"""
    try:
        # Get user context
        auth_context = getattr(request.state, 'auth_context', None)
        tenant_id = None
        if auth_context:
            tenant_id = str(auth_context['data'].get('tenant_id'))

        if not tenant_id:
            raise HTTPException(status_code=401, detail="User ID not found in auth context")

        # Get user UUID
        try:
            tenant_uuid = uuid.UUID(tenant_id)
        except ValueError:
            logger.error(f"Invalid tenant_id format: {tenant_id}")
            raise HTTPException(status_code=400, detail="Invalid user ID format")

        # Note: Security Gateway configurations are tenant-level and available across all applications
        # We don't filter by application_id for upstream API configs
        from database.models import UpstreamApiConfig, OnlineTestModelSelection

        # Get user's upstream API configuration (tenant-level, not filtered by application)
        # Security Gateway configurations are tenant-level and should be available across all applications
        query = db.query(UpstreamApiConfig).filter(
            UpstreamApiConfig.tenant_id == tenant_uuid,
            UpstreamApiConfig.is_active == True
        )

        proxy_models = query.all()
        
        # Get user's online test model selection
        selections = db.query(OnlineTestModelSelection).filter(
            OnlineTestModelSelection.tenant_id == tenant_uuid
        ).all()
        
        # Create selection mapping with model_name
        selection_map = {str(sel.proxy_model_id): {"selected": sel.selected, "model_name": sel.model_name} for sel in selections}
        
        # Construct return data
        result = []
        for model in proxy_models:
            selection_data = selection_map.get(str(model.id), {"selected": False, "model_name": None})
            model_info = OnlineTestModelInfo(
                id=str(model.id),
                config_name=model.config_name,
                api_base_url=model.api_base_url,
                provider=model.provider,
                is_active=model.is_active,
                selected=selection_data["selected"],
                model_name=selection_data["model_name"]
            )
            result.append(model_info)
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Get online test models error: {e}")
        raise HTTPException(status_code=500, detail=f"Get model list failed: {str(e)}")

@router.post("/test/models/selection")
async def update_model_selection(
    request_data: UpdateModelSelectionRequest,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Update online test model selection"""
    try:
        # Get user context
        auth_context = getattr(request.state, 'auth_context', None)
        tenant_id = None
        if auth_context:
            tenant_id = str(auth_context['data'].get('tenant_id'))

        if not tenant_id:
            raise HTTPException(status_code=401, detail="User ID not found in auth context")

        # Get user UUID
        try:
            tenant_uuid = uuid.UUID(tenant_id)
        except ValueError:
            logger.error(f"Invalid tenant_id format: {tenant_id}")
            raise HTTPException(status_code=400, detail="Invalid user ID format")

        # Note: Security Gateway configurations are tenant-level and available across all applications
        # We don't filter by application_id for upstream API configs
        from database.models import OnlineTestModelSelection, UpstreamApiConfig

        # Update selection status for each model
        for selection in request_data.model_selections:
            model_id = selection['id']
            selected = selection['selected']
            model_name = selection.get('model_name', None)  # Get model_name from request
            
            # Validate model ID format
            try:
                proxy_model_uuid = uuid.UUID(model_id)
            except ValueError:
                logger.error(f"Invalid model_id format: {model_id}")
                continue
            
            # Validate model belongs to the user (tenant-level validation)
            # Security Gateway configurations are tenant-level, not application-specific
            proxy_model = db.query(UpstreamApiConfig).filter(
                UpstreamApiConfig.id == proxy_model_uuid,
                UpstreamApiConfig.tenant_id == tenant_uuid
            ).first()

            if not proxy_model:
                continue  # Skip models that do not belong to the user
            
            # Find existing selection record
            existing_selection = db.query(OnlineTestModelSelection).filter(
                OnlineTestModelSelection.tenant_id == tenant_uuid,
                OnlineTestModelSelection.proxy_model_id == proxy_model_uuid
            ).first()
            
            if existing_selection:
                # Update existing record
                existing_selection.selected = selected
                existing_selection.model_name = model_name
            else:
                # Create new record
                new_selection = OnlineTestModelSelection(
                    tenant_id=tenant_uuid,
                    proxy_model_id=proxy_model_uuid,
                    selected=selected,
                    model_name=model_name
                )
                db.add(new_selection)
        
        db.commit()
        return {"message": "Model selection updated"}
        
    except HTTPException:
        raise
    except Exception as e:
        db.rollback()
        logger.error(f"Update model selection error: {e}")
        raise HTTPException(status_code=500, detail=f"Update model selection failed: {str(e)}")

@router.post("/test/online", response_model=OnlineTestResponse)
async def online_test(
    request_data: OnlineTestRequest,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    Online test API

    Support testing guardrail detection capability, and also test the response of the protected model
    """
    try:
        # Get user context
        auth_context = getattr(request.state, 'auth_context', None)
        tenant_id = None
        if auth_context:
            tenant_id = str(auth_context['data'].get('tenant_id'))

        if not tenant_id:
            raise HTTPException(status_code=401, detail="User ID not found in auth context")

        # Get application_id from header or auth context (application-level filtering)
        from database.models import Application

        # 0) Check for X-Application-ID header (highest priority - from frontend selector)
        header_app_id = request.headers.get('x-application-id') or request.headers.get('X-Application-ID')

        # 1) Use header application ID if present
        application_id = None
        if header_app_id:
            try:
                application_id = uuid.UUID(header_app_id)
            except ValueError:
                logger.error(f"Invalid application_id format from header: {header_app_id}")
                raise HTTPException(status_code=400, detail="Invalid application ID format")

        # 2) If no header, check auth context (for API key authentication)
        if not application_id and auth_context:
            auth_app_id = auth_context['data'].get('application_id')
            if auth_app_id:
                try:
                    application_id = uuid.UUID(auth_app_id)
                except ValueError:
                    logger.error(f"Invalid application_id format from auth: {auth_app_id}")

        # 3) If still no application_id, get the first application for this tenant (backward compatibility)
        if not application_id:
            # Get user UUID first
            try:
                tenant_uuid = uuid.UUID(tenant_id)
            except ValueError:
                logger.error(f"Invalid tenant_id format: {tenant_id}")
                raise HTTPException(status_code=400, detail="Invalid user ID format")

            first_app = db.query(Application).filter(
                Application.tenant_id == tenant_uuid
            ).first()
            if first_app:
                application_id = first_app.id

        # Construct message format
        messages = []
        if request_data.input_type == 'question':
            # Check if there is image data
            if request_data.images and len(request_data.images) > 0:
                # Multimodal message format
                content = []
                # Add text content (if any)
                if request_data.content.strip():
                    content.append({"type": "text", "text": request_data.content})
                # Add image content
                for image_base64 in request_data.images:
                    content.append({
                        "type": "image_url",
                        "image_url": {"url": image_base64}
                    })
                messages = [{"role": "user", "content": content}]
            else:
                # Pure text message format
                messages = [{"role": "user", "content": request_data.content}]
        else:  # qa_pair
            # Parse qa pair
            lines = request_data.content.split('\n')
            question = None
            answer = None
            
            for line in lines:
                if line.strip().startswith('Q:'):
                    question = line[2:].strip()
                elif line.strip().startswith('A:'):
                    answer = line[2:].strip()
            
            if not question or not answer:
                raise HTTPException(status_code=400, detail="Qa pair format error, please use Q: question\\nA: answer format")
            
            messages = [
                {"role": "user", "content": question},
                {"role": "assistant", "content": answer}
            ]
        
        # Get user API key
        user_api_key = None
        if auth_context and auth_context.get('type') in ['api_key', 'api_key_switched']:
            user_api_key = auth_context['data'].get('api_key')
        
        # Get user UUID
        try:
            tenant_uuid = uuid.UUID(tenant_id)
        except ValueError:
            logger.error(f"Invalid tenant_id format: {tenant_id}")
            raise HTTPException(status_code=400, detail="Invalid user ID format")
        
        if not user_api_key:
            # If JWT login, need to get tenant's API key from database
            tenant = db.query(Tenant).filter(Tenant.id == tenant_uuid).first()
            if tenant:
                user_api_key = tenant.api_key
        
        if not user_api_key:
            raise HTTPException(status_code=400, detail="User API key not found")
        
        # Use user API key to call guardrail API (with application_id)
        has_images = request_data.images and len(request_data.images) > 0
        guardrail_dict = await call_guardrail_api(user_api_key, messages, tenant_uuid, db, has_images, application_id)
        
        # If question type, get user selected proxy model for test
        model_results = {}
        original_responses = {}
        if request_data.input_type == 'question':
            # Get user selected upstream API configuration from database
            from database.models import UpstreamApiConfig, OnlineTestModelSelection

            # If specified model in request, use specified model, otherwise use user selected model
            if request_data.models:
                # Compatible with original request format, but now using upstream_api_configs
                enabled_model_ids = [m.id for m in request_data.models if m.enabled]
                logger.info(f"Testing specific models: {enabled_model_ids}")

                # Note: Security Gateway configurations are tenant-level, not application-specific
                # Do NOT filter by application_id as it's deprecated and always NULL
                # Also get model_name from OnlineTestModelSelection if exists
                query = db.query(UpstreamApiConfig, OnlineTestModelSelection.model_name).outerjoin(
                    OnlineTestModelSelection,
                    (UpstreamApiConfig.id == OnlineTestModelSelection.proxy_model_id) &
                    (OnlineTestModelSelection.tenant_id == tenant_uuid)
                ).filter(
                    UpstreamApiConfig.id.in_(enabled_model_ids),
                    UpstreamApiConfig.tenant_id == tenant_uuid,
                    UpstreamApiConfig.is_active == True
                )

                db_models_with_names = query.all()
            else:
                # Get user selected upstream API configs
                # Note: Security Gateway configurations are tenant-level, not application-specific
                # Do NOT filter by application_id as it's deprecated and always NULL
                selected_models_query = db.query(UpstreamApiConfig, OnlineTestModelSelection.model_name).join(
                    OnlineTestModelSelection,
                    UpstreamApiConfig.id == OnlineTestModelSelection.proxy_model_id
                ).filter(
                    UpstreamApiConfig.tenant_id == tenant_uuid,
                    UpstreamApiConfig.is_active == True,
                    OnlineTestModelSelection.selected == True
                )

                db_models_with_names = selected_models_query.all()
            
            logger.info(f"Found {len(db_models_with_names)} models in database")
            
            # Call all enabled models to get original response (not through guardrail)
            original_tasks = []
            for db_model, user_model_name in db_models_with_names:
                # Decrypt API key
                try:
                    decrypted_api_key = proxy_service._decrypt_api_key(db_model.api_key_encrypted)
                except Exception as e:
                    logger.error(f"Failed to decrypt API key for model {db_model.id}: {e}")
                    continue
                
                # Use user-specified model_name if available, otherwise use sensible defaults
                if user_model_name:
                    model_name = user_model_name
                else:
                    # Determine default model name based on provider
                    # For upstream configs, use sensible defaults based on provider
                    default_model_names = {
                        'openai': 'gpt-4',
                        'anthropic': 'claude-3-5-sonnet-20241022',
                        'local': 'local-model',
                        'other': 'default-model'
                    }
                    model_name = default_model_names.get(db_model.provider or 'other', 'default-model')

                # Create ModelConfig object
                model_config = ModelConfig(
                    id=str(db_model.id),
                    name=db_model.config_name,
                    base_url=db_model.api_base_url,
                    api_key=decrypted_api_key,
                    model_name=model_name,
                    enabled=db_model.is_active
                )
                # Directly call model to get original response
                original_task = test_model_api(model_config, messages)
                original_tasks.append((str(db_model.id), original_task))
            
            # Wait for all models' original response
            if original_tasks:
                original_results = await asyncio.gather(
                    *[task for _, task in original_tasks], 
                    return_exceptions=True
                )
                
                for i, (model_id, _) in enumerate(original_tasks):
                    result = original_results[i]
                    if isinstance(result, Exception):
                        original_responses[model_id] = ModelResponse(
                            content=None,
                            error=f"Request failed: {str(result)}"
                        )
                    else:
                        original_responses[model_id] = result
            
            # Generate guardrail protected response based on guardrail result
            for model_id in original_responses:
                if (guardrail_dict.get('suggest_action', '') == '通过' or 
                    guardrail_dict.get('overall_risk_level', '') in ['无风险', 'safe']):
                    # If guardrail passed, guardrail protected response directly use original response
                    model_results[model_id] = original_responses[model_id]
                else:
                    # If guardrail blocked, use suggested answer or reject message
                    suggest_answer = guardrail_dict.get('suggest_answer', '')
                    if suggest_answer:
                        model_results[model_id] = ModelResponse(content=suggest_answer)
                    else:
                        model_results[model_id] = ModelResponse(content="Sorry, I cannot answer this question, because it may violate the security criteria.")
        
        return OnlineTestResponse(
            guardrail=guardrail_dict,
            models=model_results,
            original_responses=original_responses
        )
        
    except HTTPException:
        # Re-throw HTTPException (including 429 rate limit error), do not convert to 500 error
        raise
    except Exception as e:
        import traceback
        error_msg = f"Online test error: {e}\nTraceback: {traceback.format_exc()}"
        logger.error(error_msg)
        
        # Improve timeout error handling
        error_str = str(e).lower()
        if "timeout" in error_str or "timed out" in error_str:
            raise HTTPException(
                status_code=408, 
                detail="Test execution timeout, this may be due to model response time being too long. Please try again later, or contact the administrator to check the model configuration."
            )
        else:
            raise HTTPException(status_code=500, detail=f"Test execution failed: {str(e)}")

async def call_guardrail_api(api_key: str, messages: List[Dict[str, Any]], tenant_uuid: uuid.UUID, db: Session, has_images: bool = False, application_id: Optional[uuid.UUID] = None) -> Dict[str, Any]:
    """Call guardrail API"""
    try:
        # Build guardrail API URL - automatically adapt to environment based on configuration
        guardrail_url = f"http://{settings.detection_host}:{settings.detection_port}/v1/guardrails"

        # Select appropriate model based on whether there is image
        model_name = "OpenGuardrails-VL" if has_images else "OpenGuardrails-Text"

        # Build headers (include application_id if available)
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "X-Online-Test": "true"  # Mark this as online test request to bypass rate limiting
        }
        if application_id:
            headers["X-Application-ID"] = str(application_id)

        async with httpx.AsyncClient(timeout=180.0) as client:  # Increase guardrail API timeout to 3 minutes
            response = await client.post(
                guardrail_url,
                headers=headers,
                json={
                    "model": model_name,
                    "messages": messages
                }
            )
            
            if response.status_code == 200:
                result = response.json()
                return {
                    "compliance": {
                        "risk_level": result.get('result', {}).get('compliance', {}).get('risk_level', '无风险'),
                        "categories": result.get('result', {}).get('compliance', {}).get('categories', [])
                    },
                    "security": {
                        "risk_level": result.get('result', {}).get('security', {}).get('risk_level', '无风险'),
                        "categories": result.get('result', {}).get('security', {}).get('categories', [])
                    },
                    "data": {
                        "risk_level": result.get('result', {}).get('data', {}).get('risk_level', '无风险'),
                        "categories": result.get('result', {}).get('data', {}).get('categories', [])
                    },
                    "overall_risk_level": result.get('overall_risk_level', '无风险'),
                    "suggest_action": result.get('suggest_action', '通过'),
                    "suggest_answer": result.get('suggest_answer', '')
                }
            elif response.status_code == 429:
                # Handle rate limit error, get user rate limit configuration
                try:
                    from services.rate_limiter import RateLimitService
                    rate_limit_service = RateLimitService(db)
                    rate_limit_config = rate_limit_service.get_user_rate_limit(str(tenant_uuid))
                    rate_limit = rate_limit_config.requests_per_second if rate_limit_config and rate_limit_config.is_active else 10
                    
                    rate_limit_text = "No limit" if rate_limit == 0 else f"{rate_limit} requests/second"
                    
                    raise HTTPException(
                        status_code=429, 
                        detail=f"API call frequency exceeds limit, please try again later. Current rate limit: {rate_limit_text}. If you need to adjust, please contact the administrator {settings.support_email}"
                    )
                except HTTPException:
                    raise
                except Exception as e:
                    logger.error(f"Get user rate limit configuration failed: {e}")
                    raise HTTPException(
                        status_code=429, 
                        detail="API call frequency exceeds limit, please try again later. Please check your API speed limit settings."
                    )
            else:
                raise Exception(f"Guardrail API call failed: HTTP {response.status_code}")
                
    except HTTPException:
        # Re-throw HTTPException, do not catch
        raise
    except Exception as e:
        logger.error(f"Guardrail API call failed: {e}")
        # Check if it is a rate limit related error
        error_str = str(e).lower()
        if "rate limit" in error_str or "429" in error_str or "too many requests" in error_str:
            try:
                from services.rate_limiter import RateLimitService
                rate_limit_service = RateLimitService(db)
                rate_limit_config = rate_limit_service.get_user_rate_limit(str(tenant_uuid))
                rate_limit = rate_limit_config.requests_per_second if rate_limit_config and rate_limit_config.is_active else 10
                
                rate_limit_text = "No limit" if rate_limit == 0 else f"{rate_limit} requests/second"
                
                raise HTTPException(
                    status_code=429, 
                    detail=f"API call frequency exceeds limit, please try again later. Current rate limit: {rate_limit_text}. If you need to adjust, please contact the administrator {settings.support_email}"
                )
            except HTTPException:
                raise
            except Exception as ex:
                logger.error(f"Get user rate limit configuration failed: {ex}")
                raise HTTPException(
                    status_code=429, 
                    detail="API call frequency exceeds limit, please try again later. Please check your API speed limit settings."
                )
        
        return {
            "compliance": {
                "risk_level": "Test failed",
                "categories": ["System error"]
            },
            "security": {
                "risk_level": "Test failed",
                "categories": ["System error"]
            },
            "data": {
                "risk_level": "Test failed",
                "categories": []
            },
            "overall_risk_level": "Test failed",
            "suggest_action": "System error",
            "suggest_answer": f"Guardrail detection system error: {str(e)}"
        }

async def test_model_api(model: ModelConfig, messages: List[Dict[str, Any]]) -> ModelResponse:
    """使用OpenAI SDK测试单个模型API"""
    try:
        # Create OpenAI client, use longer timeout to support proxy model
        client = AsyncOpenAI(
            api_key=model.api_key,
            base_url=model.base_url.rstrip('/'),
            timeout=600.0  # 10 minutes timeout
        )
        
        # Call model API
        response = await client.chat.completions.create(
            model=model.model_name,
            messages=messages,
            temperature=0.0
        )
        
        # Extract response content
        # If there is reasoning_content, return reasoning_content
        reasoning_content = None
        # Use getattr to safely access reasoning_content (not all models support this field)
        if response.choices and response.choices[0].message:
            reasoning_content = getattr(response.choices[0].message, 'reasoning_content', None)
        
        answer_content = response.choices[0].message.content if response.choices else 'No response'
        if reasoning_content:
            content = f"<think>\n{reasoning_content}\n</think>\n\n{answer_content}"
        else:
            content = answer_content
        
        return ModelResponse(content=content)
        
    except Exception as e:
        error_message = str(e)
        if "401" in error_message or "Unauthorized" in error_message:
            error_message = "API Key invalid or unauthorized"
        elif "404" in error_message or "Not Found" in error_message:
            error_message = "API endpoint not found or model not exists"
        elif "timeout" in error_message.lower() or "timed out" in error_message.lower():
            error_message = "Request timeout, model response time too long, please try again later or contact the administrator"
        elif "rate limit" in error_message.lower():
            error_message = "API call frequency limit"
        else:
            error_message = f"Request failed: {error_message}"
            
        logger.error(f"Model API call failed for {model.name}: {error_message}")
        return ModelResponse(
            content=None,
            error=error_message
        )