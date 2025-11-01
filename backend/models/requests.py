from typing import List, Optional, Union, Any, Dict
from pydantic import BaseModel, Field, validator, ConfigDict

class ImageUrl(BaseModel):
    """Image URL model - support file:// path, http(s):// URL or data:image base64 encoding"""
    url: str = Field(..., description="Image URL: file://local_path, http(s)://remote_URL, 或 data:image/jpeg;base64,{base64_coding}")

class ContentPart(BaseModel):
    """Content part model - support text and image"""
    type: str = Field(..., description="Content type: text or image_url")
    text: Optional[str] = Field(None, description="Text content")
    image_url: Optional[ImageUrl] = Field(None, description="Image URL")

    @validator('type')
    def validate_type(cls, v):
        if v not in ['text', 'image_url']:
            raise ValueError('type must be one of: text, image_url')
        return v

class Message(BaseModel):
    """Message model - support text and multi-modal content"""
    role: str = Field(..., description="Message role: user, system, assistant")
    content: Union[str, List[ContentPart]] = Field(..., description="Message content, can be string or content part list")

    @validator('role')
    def validate_role(cls, v):
        if v not in ['user', 'system', 'assistant']:
            raise ValueError('role must be one of: user, system, assistant')
        return v

    @validator('content')
    def validate_content(cls, v):
        if isinstance(v, str):
            if not v or not v.strip():
                raise ValueError('content cannot be empty')
            if len(v) > 1000000:
                raise ValueError('content too long (max 1000000 characters)')
            return v.strip()
        elif isinstance(v, list):
            if not v:
                raise ValueError('content cannot be empty')
            return v
        else:
            raise ValueError('content must be string or list of content parts')
        return v

class GuardrailRequest(BaseModel):
    """Guardrail detection request model"""
    model: str = Field(..., description="模型名称")
    messages: List[Message] = Field(..., description="Message list")
    max_tokens: Optional[int] = Field(None, description="Maximum tokens")
    extra_body: Optional[Dict[str, Any]] = Field(None, description="Extra parameters, can contain xxai_app_user_id etc.")

    @validator('messages')
    def validate_messages(cls, v):
        if not v:
            raise ValueError('messages cannot be empty')
        return v

class BlacklistRequest(BaseModel):
    """Blacklist request model"""
    name: str = Field(..., description="Blacklist library name")
    keywords: List[str] = Field(..., description="Keyword list")
    description: Optional[str] = Field(None, description="Description")
    is_active: bool = Field(True, description="Whether enabled")
    
    @validator('keywords')
    def validate_keywords(cls, v):
        if not v:
            raise ValueError('keywords cannot be empty')
        return [kw.strip() for kw in v if kw.strip()]

class WhitelistRequest(BaseModel):
    """Whitelist request model"""
    name: str = Field(..., description="Whitelist library name")
    keywords: List[str] = Field(..., description="Keyword list")
    description: Optional[str] = Field(None, description="Description")
    is_active: bool = Field(True, description="Whether enabled")
    
    @validator('keywords')
    def validate_keywords(cls, v):
        if not v:
            raise ValueError('keywords cannot be empty')
        return [kw.strip() for kw in v if kw.strip()]

class ResponseTemplateRequest(BaseModel):
    """Response template request model"""
    category: str = Field(..., description="Risk category")
    risk_level: str = Field(..., description="Risk level")
    template_content: Dict[str, str] = Field(..., description="Multilingual response template content: {'en': '...', 'zh': '...', ...}")
    is_default: bool = Field(False, description="Whether it is a default template")
    is_active: bool = Field(True, description="Whether enabled")
    
    @validator('category')
    def validate_category(cls, v):
        valid_categories = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12', 'S13', 'S14', 'S15', 'S16', 'S17', 'S18', 'S19', 'S20', 'S21', 'default']
        if v not in valid_categories:
            raise ValueError(f'category must be one of: {valid_categories}')
        return v
    
    @validator('risk_level')
    def validate_risk_level(cls, v):
        # Accept both underscore format (from database/frontend) and space format (legacy)
        valid_values = ['no_risk', 'low_risk', 'medium_risk', 'high_risk', 'no risk', 'low risk', 'medium risk', 'high risk']
        if v not in valid_values:
            raise ValueError('risk_level must be one of: no_risk, low_risk, medium_risk, high_risk (or legacy: no risk, low risk, medium risk, high risk)')
        # Normalize to underscore format for consistency
        return v.replace(' ', '_')

class ProxyCompletionRequest(BaseModel):
    """Proxy completion request model"""
    model: str = Field(..., description="Model name")
    messages: List[Message] = Field(..., description="Message list")
    temperature: Optional[float] = Field(None, description="Temperature parameter")
    top_p: Optional[float] = Field(None, description="Top-p parameter")
    n: Optional[int] = Field(1, description="Generation quantity")
    stream: Optional[bool] = Field(False, description="Whether to stream output")
    stop: Optional[Union[str, List[str]]] = Field(None, description="Stop word")
    max_tokens: Optional[int] = Field(None, description="Maximum token number")
    presence_penalty: Optional[float] = Field(None, description="Presence penalty")
    frequency_penalty: Optional[float] = Field(None, description="Frequency penalty")
    user: Optional[str] = Field(None, description="User identifier")

class ProxyModelConfig(BaseModel):
    """Proxy model config model"""
    config_name: str = Field(..., description="Config name")
    api_base_url: str = Field(..., description="API base URL")
    api_key: str = Field(..., description="API key")
    model_name: str = Field(..., description="Model name")
    enabled: Optional[bool] = Field(True, description="Whether enabled")

    # Allow fields starting with model_
    model_config = ConfigDict(protected_namespaces=())

    # 安全配置（极简设计）
    block_on_input_risk: Optional[bool] = Field(False, description="Whether to block on input risk, default not block")
    block_on_output_risk: Optional[bool] = Field(False, description="Whether to block on output risk, default not block")
    enable_reasoning_detection: Optional[bool] = Field(True, description="Whether to detect reasoning content, default enabled")
    stream_chunk_size: Optional[int] = Field(50, description="Stream detection interval, detect every N chunks, default 50", ge=1, le=500)

class InputGuardrailRequest(BaseModel):
    """Input detection request model - For dify/coze etc. agent platform plugins"""
    input: str = Field(..., description="User input text")
    model: Optional[str] = Field("OpenGuardrails-Text", description="Model name")
    xxai_app_user_id: Optional[str] = Field(None, description="Tenant AI application user ID")

    @validator('input')
    def validate_input(cls, v):
        if not v or not v.strip():
            raise ValueError('input cannot be empty')
        if len(v) > 1000000:
            raise ValueError('input too long (max 1000000 characters)')
        return v.strip()

class OutputGuardrailRequest(BaseModel):
    """Output detection request model - For dify/coze etc. agent platform plugins"""
    input: str = Field(..., description="User input text")
    output: str = Field(..., description="Model output text")
    xxai_app_user_id: Optional[str] = Field(None, description="Tenant AI application user ID")

    @validator('input')
    def validate_input(cls, v):
        if not v or not v.strip():
            raise ValueError('input cannot be empty')
        if len(v) > 1000000:
            raise ValueError('input too long (max 1000000 characters)')
        return v.strip()

    @validator('output')
    def validate_output(cls, v):
        if not v or not v.strip():
            raise ValueError('output cannot be empty')
        if len(v) > 1000000:
            raise ValueError('output too long (max 1000000 characters)')
        return v.strip()

class ConfidenceThresholdRequest(BaseModel):
    """Confidence threshold configuration request model"""
    high_confidence_threshold: float = Field(..., description="High confidence threshold", ge=0.0, le=1.0)
    medium_confidence_threshold: float = Field(..., description="Medium confidence threshold", ge=0.0, le=1.0)
    low_confidence_threshold: float = Field(..., description="Low confidence threshold", ge=0.0, le=1.0)
    confidence_trigger_level: str = Field(..., description="Lowest confidence level to trigger detection", pattern="^(low|medium|high)$")

class KnowledgeBaseRequest(BaseModel):
    """Knowledge base request model"""
    category: str = Field(..., description="Risk category")
    name: str = Field(..., description="Knowledge base name")
    description: Optional[str] = Field(None, description="Description")
    similarity_threshold: float = Field(0.7, description="Similarity threshold for this knowledge base (0-1)", ge=0, le=1)
    is_active: bool = Field(True, description="Whether enabled")
    is_global: Optional[bool] = Field(False, description="Whether it is a global knowledge base (only admin can set)")

    @validator('category')
    def validate_category(cls, v):
        valid_categories = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12', 'S13', 'S14', 'S15', 'S16', 'S17', 'S18', 'S19', 'S20', 'S21']
        if v not in valid_categories:
            raise ValueError(f'category must be one of: {valid_categories}')
        return v

    @validator('name')
    def validate_name(cls, v):
        if not v or not v.strip():
            raise ValueError('name cannot be empty')
        if len(v.strip()) > 255:
            raise ValueError('name too long (max 255 characters)')
        return v.strip()

class DifyModerationParams(BaseModel):
    """Dify moderation request params model"""
    app_id: Optional[str] = Field(None, description="Application ID")
    inputs: Optional[Dict[str, Any]] = Field(None, description="Input variables for app.moderation.input")
    query: Optional[str] = Field(None, description="User query for app.moderation.input")
    text: Optional[str] = Field(None, description="LLM output text for app.moderation.output")

class DifyModerationRequest(BaseModel):
    """Dify API-based extension moderation request model"""
    point: str = Field(..., description="Extension point: ping, app.moderation.input, or app.moderation.output")
    params: Optional[DifyModerationParams] = Field(None, description="Request parameters")

    @validator('point')
    def validate_point(cls, v):
        valid_points = ['ping', 'app.moderation.input', 'app.moderation.output']
        if v not in valid_points:
            raise ValueError(f'point must be one of: {valid_points}')
        return v