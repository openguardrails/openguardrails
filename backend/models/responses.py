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
    detected_entities: List[Dict[str, Any]] = []  # Detected sensitive entities for anonymization
    anonymized_text: Optional[str] = None  # Anonymized text for replacement action
    restore_mapping: Optional[Dict[str, str]] = None  # Mapping for restoring numbered placeholders to original values

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
    """Response template response model - supports all scanner types"""
    id: int
    tenant_id: Optional[str] = None
    application_id: Optional[str] = None

    # Support both legacy and new formats
    category: Optional[str] = None
    scanner_type: Optional[str] = None
    scanner_identifier: Optional[str] = None
    scanner_name: Optional[str] = None  # Scanner name from Scanner table (for custom/marketplace scanners)

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
    """Knowledge base response model - supports all scanner types"""
    id: int

    # Support both legacy and new formats
    category: Optional[str] = None
    scanner_type: Optional[str] = None
    scanner_identifier: Optional[str] = None
    scanner_name: Optional[str] = None  # Scanner human-readable name for display

    name: str
    description: Optional[str]
    file_path: str
    vector_file_path: Optional[str]
    total_qa_pairs: int
    similarity_threshold: float
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


# =====================================================
# Scanner Package System Response Models
# =====================================================

class ScannerResponse(BaseModel):
    """Scanner response model"""
    id: str
    tag: str
    name: str
    description: Optional[str]
    scanner_type: str
    definition: str
    default_risk_level: str
    default_scan_prompt: bool
    default_scan_response: bool


class PackageResponse(BaseModel):
    """Scanner package response model"""
    id: str
    package_code: str
    package_name: str
    author: str
    description: Optional[str]
    version: str
    license: str
    package_type: str
    scanner_count: int
    price: Optional[float] = None
    price_display: Optional[str] = None
    bundle: Optional[str] = None
    created_at: Optional[str]
    updated_at: Optional[str]
    archived: bool = False
    archived_at: Optional[str] = None
    archive_reason: Optional[str] = None


class PackageDetailResponse(BaseModel):
    """Package detail response model (includes scanners)"""
    id: str
    package_code: str
    package_name: str
    author: str
    description: Optional[str]
    version: str
    license: str
    package_type: str
    scanner_count: int
    price: Optional[float] = None
    price_display: Optional[str] = None
    bundle: Optional[str] = None
    scanners: List[Dict[str, Any]]
    created_at: Optional[str]
    updated_at: Optional[str]


class MarketplacePackageResponse(BaseModel):
    """Marketplace package response model (no scanner definitions)"""
    id: str
    package_code: str
    package_name: str
    author: str
    description: Optional[str]
    version: str
    package_type: str
    scanner_count: int
    price: Optional[float] = None
    price_display: Optional[str]
    bundle: Optional[str] = None
    purchase_status: Optional[str]  # None, 'pending', 'approved', 'rejected'
    purchased: bool
    purchase_requested: bool
    created_at: Optional[str]


class ScannerConfigResponse(BaseModel):
    """Scanner configuration response model"""
    id: str
    tag: str
    name: str
    description: Optional[str]
    scanner_type: str
    package_name: str
    package_id: Optional[str]
    is_custom: bool
    # Effective settings (with overrides applied)
    is_enabled: bool
    risk_level: str
    scan_prompt: bool
    scan_response: bool
    # Default values
    default_risk_level: str
    default_scan_prompt: bool
    default_scan_response: bool
    # Override indicators
    has_risk_level_override: bool
    has_scan_prompt_override: bool
    has_scan_response_override: bool


class CustomScannerResponse(BaseModel):
    """Custom scanner response model"""
    id: str
    custom_scanner_id: str
    tag: str
    name: str
    description: Optional[str]
    scanner_type: str
    definition: str
    default_risk_level: str
    default_scan_prompt: bool
    default_scan_response: bool
    notes: Optional[str]
    created_by: str
    created_at: Optional[str]
    updated_at: Optional[str]
    is_enabled: bool = True


class PurchaseResponse(BaseModel):
    """Purchase response model"""
    id: str
    package_id: str
    package_name: Optional[str]
    package_code: Optional[str]
    status: str
    request_email: str
    request_message: Optional[str]
    rejection_reason: Optional[str]
    approved_at: Optional[str]
    created_at: Optional[str]


class PurchasePendingResponse(BaseModel):
    """Pending purchase response model (for admin)"""
    id: str
    tenant_id: str
    tenant_email: Optional[str]
    package_id: str
    package_name: Optional[str]
    package_code: Optional[str]
    request_email: str
    request_message: Optional[str]
    created_at: Optional[str]


class PackageStatisticsResponse(BaseModel):
    """Package statistics response model"""
    package_id: str
    package_name: str
    total_purchases: int
    approved_purchases: int
    pending_purchases: int
    scanner_count: int