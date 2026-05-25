"""
Pydantic models for Red Teaming Attack Campaigns feature
"""
from pydantic import BaseModel, Field
from typing import Optional, List
from datetime import datetime
from uuid import UUID


# =====================================================
# Package Information Models
# =====================================================

class PackageCategory(BaseModel):
    """Category within a test package"""
    code: str  # e.g., 'S1', 'LLM01'
    name: str  # e.g., '一般政治话题', 'Prompt Injection'
    name_en: str  # English name
    question_count: int


class TestPackage(BaseModel):
    """Test package information"""
    code: str  # 'gbt45654', 'owasp_top10', 'custom'
    name: str
    name_en: str
    description: str
    description_en: str
    categories: List[PackageCategory]
    total_questions: int


# =====================================================
# Test Question Models
# =====================================================

class TestQuestionBase(BaseModel):
    """Base model for test questions"""
    package_type: str = Field(..., description="Package type: gbt45654, owasp_top10, custom")
    category: str = Field(..., description="Category code: S1-S21 or LLM01-LLM10")
    content: str = Field(..., description="Question content")
    expected_action: str = Field(default="reject", description="Expected action: reject or pass")


class TestQuestionCreate(TestQuestionBase):
    """Create test question request"""
    pass


class TestQuestionResponse(TestQuestionBase):
    """Test question response"""
    id: UUID
    tenant_id: Optional[UUID] = None
    is_preset: bool = False
    created_at: datetime

    class Config:
        from_attributes = True


class GenerateQuestionsRequest(BaseModel):
    """Request to generate new test questions using AI"""
    package_type: str = Field(..., description="Package type: gbt45654, owasp_top10, custom")
    category: str = Field(..., description="Category code: S1-S21 or LLM01-LLM10")
    count: int = Field(default=5, ge=1, le=20, description="Number of questions to generate")


class GenerateQuestionsResponse(BaseModel):
    """Response from generating test questions"""
    success: bool
    questions: List[TestQuestionResponse]
    message: str


# =====================================================
# Attack Campaign Models
# =====================================================

class AttackCampaignCreate(BaseModel):
    """Create attack campaign request"""
    name: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    packages: List[str] = Field(..., description="List of package types: ['gbt45654', 'owasp_top10']")
    selected_categories: List[str] = Field(..., description="List of category codes: ['S1', 'S2', 'LLM01']")
    workspace_id: Optional[UUID] = None


class AttackCampaignUpdate(BaseModel):
    """Update attack campaign request"""
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None


class AttackCampaignResultResponse(BaseModel):
    """Individual campaign test result"""
    id: UUID
    question_id: Optional[UUID] = None
    question_content: str
    category: str
    expected_action: str
    actual_action: Optional[str] = None
    detection_result: Optional[dict] = None
    passed: Optional[bool] = None
    created_at: datetime

    class Config:
        from_attributes = True


class AttackCampaignResponse(BaseModel):
    """Attack campaign response"""
    id: UUID
    tenant_id: UUID
    name: str
    description: Optional[str] = None
    packages: List[str]
    selected_categories: List[str]
    workspace_id: Optional[UUID] = None
    workspace_name: Optional[str] = None
    status: str
    total_tests: int
    passed_tests: int
    failed_tests: int
    pass_rate: Optional[float] = None
    started_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    created_at: datetime

    class Config:
        from_attributes = True


class AttackCampaignDetailResponse(AttackCampaignResponse):
    """Attack campaign with results"""
    results: List[AttackCampaignResultResponse] = []


class RunCampaignResponse(BaseModel):
    """Response from running a campaign"""
    success: bool
    campaign_id: UUID
    status: str
    message: str


# =====================================================
# List/Filter Models
# =====================================================

class ListQuestionsParams(BaseModel):
    """Parameters for listing test questions"""
    package_type: Optional[str] = None
    category: Optional[str] = None
    is_preset: Optional[bool] = None
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=50, ge=1, le=100)


class ListCampaignsParams(BaseModel):
    """Parameters for listing campaigns"""
    status: Optional[str] = None
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=20, ge=1, le=100)
