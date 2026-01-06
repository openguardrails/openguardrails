"""
Data Leakage Policy Configuration API

Provides endpoints for managing application-level data leakage disposal policies.
"""

from typing import List, Optional
from uuid import UUID
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
from datetime import datetime

from database.connection import get_admin_db
from database.models import ApplicationDataLeakagePolicy, UpstreamApiConfig, Application
from services.data_leakage_disposal_service import DataLeakageDisposalService
from utils.logger import setup_logger

logger = setup_logger()

router = APIRouter(prefix="/api/v1/config", tags=["Data Leakage Policy"])


def get_current_user(request: Request) -> dict:
    """Get current user from request context"""
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # Handle both auth_context formats: direct dict and {data: dict}
    if isinstance(auth_context, dict) and 'data' in auth_context:
        return auth_context['data']
    elif isinstance(auth_context, dict):
        return auth_context
    else:
        raise HTTPException(status_code=401, detail="Invalid auth context")


def get_application_id(
    request: Request,
    x_application_id: Optional[str] = Header(None)
) -> UUID:
    """
    Extract application ID from header or use default.
    """
    if x_application_id:
        try:
            return UUID(x_application_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid X-Application-ID format"
            )

    # Use default application ID from user context
    current_user = get_current_user(request)
    if current_user and 'application_id' in current_user and current_user['application_id']:
        return UUID(current_user['application_id'])

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="No application context. Please provide X-Application-ID header."
    )


# Pydantic Models
class UpstreamApiConfigBrief(BaseModel):
    """Brief upstream API config for dropdown selection"""
    id: str
    config_name: str
    provider: str
    model: str
    is_data_safe: bool
    is_default_safe_model: bool
    safe_model_priority: int

    class Config:
        from_attributes = True


class DataLeakagePolicyUpdate(BaseModel):
    """Update data leakage disposal policy"""
    high_risk_action: str = Field(..., pattern='^(block|switch_safe_model|anonymize|pass)$')
    medium_risk_action: str = Field(..., pattern='^(block|switch_safe_model|anonymize|pass)$')
    low_risk_action: str = Field(..., pattern='^(block|switch_safe_model|anonymize|pass)$')
    safe_model_id: Optional[str] = None  # UUID or None to use default
    enable_format_detection: bool = True
    enable_smart_segmentation: bool = True


class DataLeakagePolicyResponse(BaseModel):
    """Data leakage policy response"""
    id: str
    application_id: str
    high_risk_action: str
    medium_risk_action: str
    low_risk_action: str
    safe_model: Optional[UpstreamApiConfigBrief] = None
    available_safe_models: List[UpstreamApiConfigBrief] = []
    enable_format_detection: bool
    enable_smart_segmentation: bool
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# API Endpoints
@router.get("/data-leakage-policy", response_model=DataLeakagePolicyResponse)
async def get_data_leakage_policy(
    request: Request,
    application_id: UUID = Depends(get_application_id),
    db: Session = Depends(get_admin_db)
):
    """
    Get application's data leakage disposal policy

    Requires X-Application-ID header. If policy doesn't exist, creates default.
    """
    try:
        current_user = get_current_user(request)
        tenant_id = UUID(current_user['tenant_id'])

        # Verify application belongs to tenant
        application = db.query(Application).filter(
            Application.id == application_id,
            Application.tenant_id == tenant_id
        ).first()

        if not application:
            raise HTTPException(status_code=404, detail="Application not found or access denied")

        # Get or create policy
        disposal_service = DataLeakageDisposalService(db)
        policy = disposal_service.get_disposal_policy(str(application_id))

        if not policy:
            raise HTTPException(status_code=500, detail="Failed to retrieve or create policy")

        # Get safe model if configured
        safe_model = None
        if policy.safe_model_id:
            safe_model = db.query(UpstreamApiConfig).filter(
                UpstreamApiConfig.id == policy.safe_model_id
            ).first()

        # Get available safe models
        available_safe_models = disposal_service.list_available_safe_models(str(tenant_id))

        return DataLeakagePolicyResponse(
            id=str(policy.id),
            application_id=str(policy.application_id),
            high_risk_action=policy.high_risk_action,
            medium_risk_action=policy.medium_risk_action,
            low_risk_action=policy.low_risk_action,
            safe_model=UpstreamApiConfigBrief.from_orm(safe_model) if safe_model else None,
            available_safe_models=[
                UpstreamApiConfigBrief.from_orm(model) for model in available_safe_models
            ],
            enable_format_detection=policy.enable_format_detection,
            enable_smart_segmentation=policy.enable_smart_segmentation,
            created_at=policy.created_at,
            updated_at=policy.updated_at
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting data leakage policy: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error getting policy: {str(e)}")


@router.put("/data-leakage-policy", response_model=DataLeakagePolicyResponse)
async def update_data_leakage_policy(
    request: Request,
    policy_update: DataLeakagePolicyUpdate,
    application_id: UUID = Depends(get_application_id),
    db: Session = Depends(get_admin_db)
):
    """
    Update application's data leakage disposal policy

    Requires X-Application-ID header.
    """
    try:
        current_user = get_current_user(request)
        tenant_id = UUID(current_user['tenant_id'])

        # Verify application belongs to tenant
        application = db.query(Application).filter(
            Application.id == application_id,
            Application.tenant_id == tenant_id
        ).first()

        if not application:
            raise HTTPException(status_code=404, detail="Application not found or access denied")

        # Validate safe_model_id if provided
        if policy_update.safe_model_id:
            safe_model = db.query(UpstreamApiConfig).filter(
                UpstreamApiConfig.id == policy_update.safe_model_id,
                UpstreamApiConfig.tenant_id == tenant_id,
                UpstreamApiConfig.is_data_safe == True,
                UpstreamApiConfig.is_active == True
            ).first()

            if not safe_model:
                raise HTTPException(
                    status_code=400,
                    detail="Safe model not found or not configured as data-safe"
                )

        # Validate disposal actions if they require safe model
        disposal_service = DataLeakageDisposalService(db)
        for action_name, action_value in [
            ('high_risk_action', policy_update.high_risk_action),
            ('medium_risk_action', policy_update.medium_risk_action),
            ('low_risk_action', policy_update.low_risk_action)
        ]:
            if action_value == 'switch_safe_model':
                is_valid, error_msg = disposal_service.validate_disposal_action(
                    action_value, str(tenant_id), str(application_id)
                )
                if not is_valid and not policy_update.safe_model_id:
                    # Will use tenant default, so check if tenant has any safe model
                    available_safe_models = disposal_service.list_available_safe_models(str(tenant_id))
                    if not available_safe_models:
                        raise HTTPException(
                            status_code=400,
                            detail=f"{action_name} is 'switch_safe_model' but no safe model is available. "
                                   f"Please configure a safe model first."
                        )

        # Update policy
        success, message, updated_policy = disposal_service.update_disposal_policy(
            application_id=str(application_id),
            high_risk_action=policy_update.high_risk_action,
            medium_risk_action=policy_update.medium_risk_action,
            low_risk_action=policy_update.low_risk_action,
            safe_model_id=policy_update.safe_model_id,
            enable_format_detection=policy_update.enable_format_detection,
            enable_smart_segmentation=policy_update.enable_smart_segmentation
        )

        if not success:
            raise HTTPException(status_code=400, detail=message)

        # Get safe model if configured
        safe_model = None
        if updated_policy.safe_model_id:
            safe_model = db.query(UpstreamApiConfig).filter(
                UpstreamApiConfig.id == updated_policy.safe_model_id
            ).first()

        # Get available safe models
        available_safe_models = disposal_service.list_available_safe_models(str(tenant_id))

        return DataLeakagePolicyResponse(
            id=str(updated_policy.id),
            application_id=str(updated_policy.application_id),
            high_risk_action=updated_policy.high_risk_action,
            medium_risk_action=updated_policy.medium_risk_action,
            low_risk_action=updated_policy.low_risk_action,
            safe_model=UpstreamApiConfigBrief.from_orm(safe_model) if safe_model else None,
            available_safe_models=[
                UpstreamApiConfigBrief.from_orm(model) for model in available_safe_models
            ],
            enable_format_detection=updated_policy.enable_format_detection,
            enable_smart_segmentation=updated_policy.enable_smart_segmentation,
            created_at=updated_policy.created_at,
            updated_at=updated_policy.updated_at
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating data leakage policy: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error updating policy: {str(e)}")


@router.get("/safe-models", response_model=List[UpstreamApiConfigBrief])
async def list_safe_models(
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    List all available safe models for the tenant

    Used for dropdown selection in policy configuration UI.
    Returns models ordered by: default first, then by priority, then by creation time.
    """
    try:
        current_user = get_current_user(request)
        tenant_id = current_user['tenant_id']

        disposal_service = DataLeakageDisposalService(db)
        safe_models = disposal_service.list_available_safe_models(tenant_id)

        return [
            UpstreamApiConfigBrief.from_orm(model) for model in safe_models
        ]

    except Exception as e:
        logger.error(f"Error listing safe models: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error listing safe models: {str(e)}")