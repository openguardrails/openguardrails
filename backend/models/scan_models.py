"""
Scan Models - Pydantic models for content scanning endpoints
"""
from typing import List, Optional
from pydantic import BaseModel, Field


class EmailScanRequest(BaseModel):
    """Email scan request model"""
    content: str = Field(..., description="Email content (EML format or plain text)")


class WebpageScanRequest(BaseModel):
    """Webpage scan request model"""
    content: str = Field(..., description="Webpage content (HTML or plain text)")
    url: Optional[str] = Field(None, description="URL of the webpage being scanned")


class ScanResponse(BaseModel):
    """Scan result response model"""
    id: str = Field(..., description="Unique scan request ID")
    scan_type: str = Field(..., description="Type of scan performed (email or webpage)")
    risk_level: str = Field(..., description="Overall risk level: no_risk, low_risk, medium_risk, high_risk")
    risk_types: List[str] = Field(default_factory=list, description="List of detected risk types")
    risk_content: List[str] = Field(default_factory=list, description="List of risky content excerpts")
    score: Optional[float] = Field(None, description="Detection confidence score (0.0-1.0)")
