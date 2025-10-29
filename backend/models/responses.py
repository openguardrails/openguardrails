from typing import List, Optional, Dict, Any
from pydantic import BaseModel, ConfigDict
from datetime import datetime

class ComplianceResult(BaseModel):
    """Compliance detection result"""
    risk_level: str
    categories: List[str]

class SecurityResult(BaseModel):
    """Security detection result"""
    risk_level: str
    categories: List[str]

class DataSecurityResult(BaseModel):
    """Data security detection result"""
    risk_level: str
    categories: List[str]

class GuardrailResult(BaseModel):
    """Guardrail detection result"""
    compliance: ComplianceResult
    security: SecurityResult
    data: DataSecurityResult

class GuardrailResponse(BaseModel):
    """Guardrail API response model"""
    id: str
    result: GuardrailResult
    overall_risk_level: str  # Overall risk level: no risk/low risk/medium risk/high risk
    suggest_action: str  # Pass, Decline, Delegate
    suggest_answer: Optional[str] = None
    score: Optional[float] = None  # Detection probability score (0.0-1.0)

class DetectionResultResponse(BaseModel):
    """Detection result response model"""
    id: int
    request_id: str
    content: str
    suggest_action: Optional[str]
    suggest_answer: Optional[str]
    hit_keywords: Optional[str]
    created_at: datetime
    ip_address: Optional[str]
    # Separated security and compliance detection results
    security_risk_level: str = "no_risk"
    security_categories: List[str] = []
    compliance_risk_level: str = "no_risk"
    compliance_categories: List[str] = []
    # Data security detection results
    data_risk_level: str = "no_risk"
    data_categories: List[str] = []
    # Detection result related fields
    score: Optional[float] = None  # Detection probability score (0.0-1.0)
    # 多模态相关字段
    has_image: bool = False
    image_count: int = 0
    image_paths: List[str] = []
    image_urls: List[str] = []  # Signed image access URLs

class BlacklistResponse(BaseModel):
    """Blacklist response model"""
    id: int
    name: str
    keywords: List[str]
    description: Optional[str]
    is_active: bool
    created_at: datetime
    updated_at: datetime

class WhitelistResponse(BaseModel):
    """Whitelist response model"""
    id: int
    name: str
    keywords: List[str]
    description: Optional[str]
    is_active: bool
    created_at: datetime
    updated_at: datetime

class ResponseTemplateResponse(BaseModel):
    """Response template response model"""
    id: int
    category: str
    risk_level: str
    template_content: Dict[str, str]  # Multilingual content: {"en": "...", "zh": "...", ...}
    is_default: bool
    is_active: bool
    created_at: datetime
    updated_at: datetime

class SensitivityThresholdResponse(BaseModel):
    """Sensitivity threshold configuration response model"""
    high_sensitivity_threshold: float      # High sensitivity threshold
    medium_sensitivity_threshold: float    # Medium sensitivity threshold
    low_sensitivity_threshold: float       # Low sensitivity threshold
    sensitivity_trigger_level: str         # Lowest sensitivity level to trigger detection

class DashboardStats(BaseModel):
    """Dashboard statistics data"""
    total_requests: int
    security_risks: int
    compliance_risks: int
    data_leaks: int
    high_risk_count: int
    medium_risk_count: int
    low_risk_count: int
    safe_count: int
    risk_distribution: Dict[str, int]
    daily_trends: List[Dict[str, Any]]

class PaginatedResponse(BaseModel):
    """Paginated response model"""
    items: List[Any]
    total: int
    page: int
    per_page: int
    pages: int

class ApiResponse(BaseModel):
    """Generic API response"""
    success: bool
    message: str
    data: Optional[Any] = None

class ProxyCompletionResponse(BaseModel):
    """Proxy completion response model"""
    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: List[Dict[str, Any]]
    usage: Optional[Dict[str, int]] = None

class ProxyModelListResponse(BaseModel):
    """Proxy model list response"""
    object: str = "list"
    data: List[Dict[str, Any]]

class KnowledgeBaseResponse(BaseModel):
    """Knowledge base response model"""
    id: int
    category: str
    name: str
    description: Optional[str]
    file_path: str
    vector_file_path: Optional[str]
    total_qa_pairs: int
    is_active: bool
    is_global: bool
    is_disabled_by_me: bool = False  # Whether current user has disabled this global KB
    created_at: datetime
    updated_at: datetime

class KnowledgeBaseFileInfo(BaseModel):
    """知识库文件信息"""
    original_file_exists: bool
    vector_file_exists: bool
    original_file_size: int
    vector_file_size: int
    total_qa_pairs: int

class SimilarQuestionResult(BaseModel):
    """Similar question search result"""
    questionid: str
    question: str
    answer: str
    similarity_score: float
    rank: int

class DataSecurityEntityTypeResponse(BaseModel):
    """Data security entity type response model"""
    id: str
    entity_type: str
    display_name: str
    risk_level: str  # Low, Medium, High
    pattern: str
    anonymization_method: str
    anonymization_config: Dict[str, Any]
    check_input: bool
    check_output: bool
    is_active: bool
    is_global: bool
    created_at: datetime
    updated_at: datetime

class DifyModerationResponse(BaseModel):
    """Dify API-based extension moderation response model"""
    model_config = ConfigDict(exclude_none=True)  # Exclude None values from JSON serialization

    result: Optional[str] = None  # For ping response: "pong"
    flagged: Optional[bool] = None
    action: Optional[str] = None  # "direct_output" or "overridden"
    preset_response: Optional[str] = None  # For direct_output action
    inputs: Optional[Dict[str, Any]] = None  # For overridden action (input moderation)
    query: Optional[str] = None  # For overridden action (input moderation)
    text: Optional[str] = None  # For overridden action (output moderation)