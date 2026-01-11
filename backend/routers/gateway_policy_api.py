"""
Gateway Security Policy Configuration API

Provides endpoints for managing both general risk policies (security, safety, compliance)
and data leakage policies in a unified interface for the Security Gateway.
"""

from typing import List, Optional
from uuid import UUID
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
from datetime import datetime

from database.connection import get_admin_db
from database.models import (
    TenantDataLeakagePolicy,
    ApplicationDataLeakagePolicy,
    UpstreamApiConfig,
    Application
)
from services.data_leakage_disposal_service import DataLeakageDisposalService
from utils.logger import setup_logger

logger = setup_logger()

router = APIRouter(prefix="/api/v1/config", tags=["Gateway Policy"])


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
    """Extract application ID from header or use default."""
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
class PrivateModelBrief(BaseModel):
    """Brief private model info for dropdown selection"""
    id: str
    config_name: str
    provider: Optional[str] = None
    is_default_private_model: bool
    private_model_names: List[str] = []

    class Config:
        from_attributes = True

    @classmethod
    def from_orm(cls, obj):
        return cls(
            id=str(obj.id),
            config_name=obj.config_name,
            provider=obj.provider,
            is_default_private_model=obj.is_default_private_model if obj.is_default_private_model else False,
            private_model_names=obj.private_model_names if obj.private_model_names else []
        )


class GatewayPolicyUpdate(BaseModel):
    """Update gateway security policy"""
    # General Risk Policy - Input (security, safety, compliance)
    # Actions: 'block' | 'replace' (use knowledge base/template) | 'pass' (log only)
    general_input_high_risk_action: Optional[str] = Field(None, pattern='^(block|replace|pass)$')
    general_input_medium_risk_action: Optional[str] = Field(None, pattern='^(block|replace|pass)$')
    general_input_low_risk_action: Optional[str] = Field(None, pattern='^(block|replace|pass)$')

    # General Risk Policy - Output (security, safety, compliance)
    # Actions: 'block' | 'replace' (use knowledge base/template) | 'pass' (log only)
    general_output_high_risk_action: Optional[str] = Field(None, pattern='^(block|replace|pass)$')
    general_output_medium_risk_action: Optional[str] = Field(None, pattern='^(block|replace|pass)$')
    general_output_low_risk_action: Optional[str] = Field(None, pattern='^(block|replace|pass)$')

    # Data Leakage - Input Policy
    # Actions: 'block' | 'switch_private_model' | 'anonymize' | 'pass'
    input_high_risk_action: Optional[str] = Field(None, pattern='^(block|switch_private_model|anonymize|pass)$')
    input_medium_risk_action: Optional[str] = Field(None, pattern='^(block|switch_private_model|anonymize|pass)$')
    input_low_risk_action: Optional[str] = Field(None, pattern='^(block|switch_private_model|anonymize|pass)$')

    # Data Leakage - Output Policy
    # Actions: 'block' | 'switch_private_model' | 'anonymize' | 'pass'
    output_high_risk_action: Optional[str] = Field(None, pattern='^(block|switch_private_model|anonymize|pass)$')
    output_medium_risk_action: Optional[str] = Field(None, pattern='^(block|switch_private_model|anonymize|pass)$')
    output_low_risk_action: Optional[str] = Field(None, pattern='^(block|switch_private_model|anonymize|pass)$')

    # Private model for data leakage switching
    private_model_id: Optional[str] = None


class GatewayPolicyResponse(BaseModel):
    """Gateway security policy response"""
    id: str
    application_id: str

    # General Risk Policy - Input - resolved values
    general_input_high_risk_action: str
    general_input_medium_risk_action: str
    general_input_low_risk_action: str

    # General Risk Policy - Input - overrides (NULL = use tenant default)
    general_input_high_risk_action_override: Optional[str]
    general_input_medium_risk_action_override: Optional[str]
    general_input_low_risk_action_override: Optional[str]

    # General Risk Policy - Output - resolved values
    general_output_high_risk_action: str
    general_output_medium_risk_action: str
    general_output_low_risk_action: str

    # General Risk Policy - Output - overrides (NULL = use tenant default)
    general_output_high_risk_action_override: Optional[str]
    general_output_medium_risk_action_override: Optional[str]
    general_output_low_risk_action_override: Optional[str]

    # Data Leakage - Input Policy - resolved values
    input_high_risk_action: str
    input_medium_risk_action: str
    input_low_risk_action: str

    # Data Leakage - Input Policy - overrides
    input_high_risk_action_override: Optional[str]
    input_medium_risk_action_override: Optional[str]
    input_low_risk_action_override: Optional[str]

    # Data Leakage - Output Policy - resolved values
    output_high_risk_action: str
    output_medium_risk_action: str
    output_low_risk_action: str

    # Data Leakage - Output Policy - overrides
    output_high_risk_action_override: Optional[str]
    output_medium_risk_action_override: Optional[str]
    output_low_risk_action_override: Optional[str]

    # Private model
    private_model: Optional[PrivateModelBrief] = None
    private_model_override: Optional[str] = None
    available_private_models: List[PrivateModelBrief] = []

    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class TenantGatewayPolicyResponse(BaseModel):
    """Tenant-level default gateway policy response"""
    id: str
    tenant_id: str

    # General Risk Policy - Input defaults
    default_general_input_high_risk_action: str
    default_general_input_medium_risk_action: str
    default_general_input_low_risk_action: str

    # General Risk Policy - Output defaults
    default_general_output_high_risk_action: str
    default_general_output_medium_risk_action: str
    default_general_output_low_risk_action: str

    # Data Leakage - Input Policy defaults
    default_input_high_risk_action: str
    default_input_medium_risk_action: str
    default_input_low_risk_action: str

    # Data Leakage - Output Policy defaults
    default_output_high_risk_action: str
    default_output_medium_risk_action: str
    default_output_low_risk_action: str

    # Private model
    default_private_model: Optional[PrivateModelBrief] = None
    available_private_models: List[PrivateModelBrief] = []

    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class TenantGatewayPolicyUpdate(BaseModel):
    """Update tenant-level default gateway policy"""
    # General Risk Policy - Input defaults
    default_general_input_high_risk_action: str = Field(..., pattern='^(block|replace|pass)$')
    default_general_input_medium_risk_action: str = Field(..., pattern='^(block|replace|pass)$')
    default_general_input_low_risk_action: str = Field(..., pattern='^(block|replace|pass)$')

    # General Risk Policy - Output defaults
    default_general_output_high_risk_action: str = Field(..., pattern='^(block|replace|pass)$')
    default_general_output_medium_risk_action: str = Field(..., pattern='^(block|replace|pass)$')
    default_general_output_low_risk_action: str = Field(..., pattern='^(block|replace|pass)$')

    # Data Leakage - Input Policy defaults
    default_input_high_risk_action: str = Field(..., pattern='^(block|switch_private_model|anonymize|pass)$')
    default_input_medium_risk_action: str = Field(..., pattern='^(block|switch_private_model|anonymize|pass)$')
    default_input_low_risk_action: str = Field(..., pattern='^(block|switch_private_model|anonymize|pass)$')

    # Data Leakage - Output Policy defaults
    default_output_high_risk_action: str = Field(..., pattern='^(block|switch_private_model|anonymize|pass)$')
    default_output_medium_risk_action: str = Field(..., pattern='^(block|switch_private_model|anonymize|pass)$')
    default_output_low_risk_action: str = Field(..., pattern='^(block|switch_private_model|anonymize|pass)$')


# ============================================================================
# Tenant-level default policy endpoints
# ============================================================================

@router.get("/gateway-policy/tenant-defaults", response_model=TenantGatewayPolicyResponse)
async def get_tenant_gateway_policy(
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    Get tenant's default gateway security policy.
    This policy applies to all applications unless overridden.
    """
    try:
        current_user = get_current_user(request)
        tenant_id = UUID(current_user['tenant_id'])

        # Get or create tenant policy
        tenant_policy = db.query(TenantDataLeakagePolicy).filter(
            TenantDataLeakagePolicy.tenant_id == tenant_id
        ).first()

        if not tenant_policy:
            tenant_policy = TenantDataLeakagePolicy(tenant_id=tenant_id)
            db.add(tenant_policy)
            db.commit()
            db.refresh(tenant_policy)

        # Get default private model
        default_private_model = db.query(UpstreamApiConfig).filter(
            UpstreamApiConfig.tenant_id == tenant_id,
            UpstreamApiConfig.is_private_model == True,
            UpstreamApiConfig.is_default_private_model == True,
            UpstreamApiConfig.is_active == True
        ).first()

        # Get available private models
        available_models = db.query(UpstreamApiConfig).filter(
            UpstreamApiConfig.tenant_id == tenant_id,
            UpstreamApiConfig.is_private_model == True,
            UpstreamApiConfig.is_active == True
        ).all()

        return TenantGatewayPolicyResponse(
            id=str(tenant_policy.id),
            tenant_id=str(tenant_policy.tenant_id),
            # General risk - input
            default_general_input_high_risk_action=getattr(tenant_policy, 'default_general_input_high_risk_action', None) or getattr(tenant_policy, 'default_general_high_risk_action', 'block') or 'block',
            default_general_input_medium_risk_action=getattr(tenant_policy, 'default_general_input_medium_risk_action', None) or getattr(tenant_policy, 'default_general_medium_risk_action', 'replace') or 'replace',
            default_general_input_low_risk_action=getattr(tenant_policy, 'default_general_input_low_risk_action', None) or getattr(tenant_policy, 'default_general_low_risk_action', 'pass') or 'pass',
            # General risk - output
            default_general_output_high_risk_action=getattr(tenant_policy, 'default_general_output_high_risk_action', None) or getattr(tenant_policy, 'default_general_high_risk_action', 'block') or 'block',
            default_general_output_medium_risk_action=getattr(tenant_policy, 'default_general_output_medium_risk_action', None) or getattr(tenant_policy, 'default_general_medium_risk_action', 'replace') or 'replace',
            default_general_output_low_risk_action=getattr(tenant_policy, 'default_general_output_low_risk_action', None) or getattr(tenant_policy, 'default_general_low_risk_action', 'pass') or 'pass',
            # Data leakage - input
            default_input_high_risk_action=tenant_policy.default_input_high_risk_action,
            default_input_medium_risk_action=tenant_policy.default_input_medium_risk_action,
            default_input_low_risk_action=tenant_policy.default_input_low_risk_action,
            # Data leakage - output
            default_output_high_risk_action=getattr(tenant_policy, 'default_output_high_risk_action', 'block') or 'block',
            default_output_medium_risk_action=getattr(tenant_policy, 'default_output_medium_risk_action', 'anonymize') or 'anonymize',
            default_output_low_risk_action=getattr(tenant_policy, 'default_output_low_risk_action', 'pass') or 'pass',
            default_private_model=PrivateModelBrief.from_orm(default_private_model) if default_private_model else None,
            available_private_models=[PrivateModelBrief.from_orm(m) for m in available_models],
            created_at=tenant_policy.created_at,
            updated_at=tenant_policy.updated_at
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting tenant gateway policy: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error getting tenant gateway policy: {str(e)}")


@router.put("/gateway-policy/tenant-defaults", response_model=TenantGatewayPolicyResponse)
async def update_tenant_gateway_policy(
    request: Request,
    policy_update: TenantGatewayPolicyUpdate,
    db: Session = Depends(get_admin_db)
):
    """
    Update tenant's default gateway security policy.
    Changes apply to all applications that don't have specific overrides.
    """
    try:
        current_user = get_current_user(request)
        tenant_id = UUID(current_user['tenant_id'])

        # Get or create tenant policy
        tenant_policy = db.query(TenantDataLeakagePolicy).filter(
            TenantDataLeakagePolicy.tenant_id == tenant_id
        ).first()

        if not tenant_policy:
            tenant_policy = TenantDataLeakagePolicy(tenant_id=tenant_id)
            db.add(tenant_policy)

        # Update general risk policy - input
        tenant_policy.default_general_input_high_risk_action = policy_update.default_general_input_high_risk_action
        tenant_policy.default_general_input_medium_risk_action = policy_update.default_general_input_medium_risk_action
        tenant_policy.default_general_input_low_risk_action = policy_update.default_general_input_low_risk_action

        # Update general risk policy - output
        tenant_policy.default_general_output_high_risk_action = policy_update.default_general_output_high_risk_action
        tenant_policy.default_general_output_medium_risk_action = policy_update.default_general_output_medium_risk_action
        tenant_policy.default_general_output_low_risk_action = policy_update.default_general_output_low_risk_action

        # Update data leakage - input policy
        tenant_policy.default_input_high_risk_action = policy_update.default_input_high_risk_action
        tenant_policy.default_input_medium_risk_action = policy_update.default_input_medium_risk_action
        tenant_policy.default_input_low_risk_action = policy_update.default_input_low_risk_action

        # Update data leakage - output policy
        tenant_policy.default_output_high_risk_action = policy_update.default_output_high_risk_action
        tenant_policy.default_output_medium_risk_action = policy_update.default_output_medium_risk_action
        tenant_policy.default_output_low_risk_action = policy_update.default_output_low_risk_action

        db.commit()
        db.refresh(tenant_policy)

        # Get models for response
        default_private_model = db.query(UpstreamApiConfig).filter(
            UpstreamApiConfig.tenant_id == tenant_id,
            UpstreamApiConfig.is_private_model == True,
            UpstreamApiConfig.is_default_private_model == True,
            UpstreamApiConfig.is_active == True
        ).first()

        available_models = db.query(UpstreamApiConfig).filter(
            UpstreamApiConfig.tenant_id == tenant_id,
            UpstreamApiConfig.is_private_model == True,
            UpstreamApiConfig.is_active == True
        ).all()

        return TenantGatewayPolicyResponse(
            id=str(tenant_policy.id),
            tenant_id=str(tenant_policy.tenant_id),
            # General risk - input
            default_general_input_high_risk_action=tenant_policy.default_general_input_high_risk_action,
            default_general_input_medium_risk_action=tenant_policy.default_general_input_medium_risk_action,
            default_general_input_low_risk_action=tenant_policy.default_general_input_low_risk_action,
            # General risk - output
            default_general_output_high_risk_action=tenant_policy.default_general_output_high_risk_action,
            default_general_output_medium_risk_action=tenant_policy.default_general_output_medium_risk_action,
            default_general_output_low_risk_action=tenant_policy.default_general_output_low_risk_action,
            # Data leakage - input
            default_input_high_risk_action=tenant_policy.default_input_high_risk_action,
            default_input_medium_risk_action=tenant_policy.default_input_medium_risk_action,
            default_input_low_risk_action=tenant_policy.default_input_low_risk_action,
            # Data leakage - output
            default_output_high_risk_action=tenant_policy.default_output_high_risk_action,
            default_output_medium_risk_action=tenant_policy.default_output_medium_risk_action,
            default_output_low_risk_action=tenant_policy.default_output_low_risk_action,
            default_private_model=PrivateModelBrief.from_orm(default_private_model) if default_private_model else None,
            available_private_models=[PrivateModelBrief.from_orm(m) for m in available_models],
            created_at=tenant_policy.created_at,
            updated_at=tenant_policy.updated_at
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating tenant gateway policy: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error updating tenant gateway policy: {str(e)}")


# ============================================================================
# Application-level policy endpoints
# ============================================================================

@router.get("/gateway-policy", response_model=GatewayPolicyResponse)
async def get_gateway_policy(
    request: Request,
    db: Session = Depends(get_admin_db),
    application_id: UUID = Depends(get_application_id)
):
    """
    Get gateway security policy for specific application.
    Returns resolved values (app override or tenant default) and override values.
    """
    try:
        current_user = get_current_user(request)
        tenant_id = UUID(current_user['tenant_id'])

        # Get tenant defaults
        tenant_policy = db.query(TenantDataLeakagePolicy).filter(
            TenantDataLeakagePolicy.tenant_id == tenant_id
        ).first()

        if not tenant_policy:
            tenant_policy = TenantDataLeakagePolicy(tenant_id=tenant_id)
            db.add(tenant_policy)
            db.commit()
            db.refresh(tenant_policy)

        # Get or create app policy
        app_policy = db.query(ApplicationDataLeakagePolicy).filter(
            ApplicationDataLeakagePolicy.application_id == application_id
        ).first()

        if not app_policy:
            app_policy = ApplicationDataLeakagePolicy(
                tenant_id=tenant_id,
                application_id=application_id
            )
            db.add(app_policy)
            db.commit()
            db.refresh(app_policy)

        # Resolve values (override or tenant default)
        def resolve(override, default):
            return override if override is not None else default

        # Get private model info
        private_model = None
        if app_policy.private_model_id:
            private_model = db.query(UpstreamApiConfig).filter(
                UpstreamApiConfig.id == app_policy.private_model_id
            ).first()

        # Get available private models
        available_models = db.query(UpstreamApiConfig).filter(
            UpstreamApiConfig.tenant_id == tenant_id,
            UpstreamApiConfig.is_private_model == True,
            UpstreamApiConfig.is_active == True
        ).all()

        return GatewayPolicyResponse(
            id=str(app_policy.id),
            application_id=str(app_policy.application_id),
            # General risk - input - resolved
            general_input_high_risk_action=resolve(
                getattr(app_policy, 'general_input_high_risk_action', None),
                getattr(tenant_policy, 'default_general_input_high_risk_action', None) or getattr(tenant_policy, 'default_general_high_risk_action', 'block') or 'block'
            ),
            general_input_medium_risk_action=resolve(
                getattr(app_policy, 'general_input_medium_risk_action', None),
                getattr(tenant_policy, 'default_general_input_medium_risk_action', None) or getattr(tenant_policy, 'default_general_medium_risk_action', 'replace') or 'replace'
            ),
            general_input_low_risk_action=resolve(
                getattr(app_policy, 'general_input_low_risk_action', None),
                getattr(tenant_policy, 'default_general_input_low_risk_action', None) or getattr(tenant_policy, 'default_general_low_risk_action', 'pass') or 'pass'
            ),
            # General risk - input - overrides
            general_input_high_risk_action_override=getattr(app_policy, 'general_input_high_risk_action', None),
            general_input_medium_risk_action_override=getattr(app_policy, 'general_input_medium_risk_action', None),
            general_input_low_risk_action_override=getattr(app_policy, 'general_input_low_risk_action', None),
            # General risk - output - resolved
            general_output_high_risk_action=resolve(
                getattr(app_policy, 'general_output_high_risk_action', None),
                getattr(tenant_policy, 'default_general_output_high_risk_action', None) or getattr(tenant_policy, 'default_general_high_risk_action', 'block') or 'block'
            ),
            general_output_medium_risk_action=resolve(
                getattr(app_policy, 'general_output_medium_risk_action', None),
                getattr(tenant_policy, 'default_general_output_medium_risk_action', None) or getattr(tenant_policy, 'default_general_medium_risk_action', 'replace') or 'replace'
            ),
            general_output_low_risk_action=resolve(
                getattr(app_policy, 'general_output_low_risk_action', None),
                getattr(tenant_policy, 'default_general_output_low_risk_action', None) or getattr(tenant_policy, 'default_general_low_risk_action', 'pass') or 'pass'
            ),
            # General risk - output - overrides
            general_output_high_risk_action_override=getattr(app_policy, 'general_output_high_risk_action', None),
            general_output_medium_risk_action_override=getattr(app_policy, 'general_output_medium_risk_action', None),
            general_output_low_risk_action_override=getattr(app_policy, 'general_output_low_risk_action', None),
            # Data leakage - Input policy - resolved
            input_high_risk_action=resolve(app_policy.input_high_risk_action, tenant_policy.default_input_high_risk_action),
            input_medium_risk_action=resolve(app_policy.input_medium_risk_action, tenant_policy.default_input_medium_risk_action),
            input_low_risk_action=resolve(app_policy.input_low_risk_action, tenant_policy.default_input_low_risk_action),
            # Data leakage - Input policy - overrides
            input_high_risk_action_override=app_policy.input_high_risk_action,
            input_medium_risk_action_override=app_policy.input_medium_risk_action,
            input_low_risk_action_override=app_policy.input_low_risk_action,
            # Data leakage - Output policy - resolved
            output_high_risk_action=resolve(
                getattr(app_policy, 'output_high_risk_action', None),
                getattr(tenant_policy, 'default_output_high_risk_action', 'block') or 'block'
            ),
            output_medium_risk_action=resolve(
                getattr(app_policy, 'output_medium_risk_action', None),
                getattr(tenant_policy, 'default_output_medium_risk_action', 'anonymize') or 'anonymize'
            ),
            output_low_risk_action=resolve(
                getattr(app_policy, 'output_low_risk_action', None),
                getattr(tenant_policy, 'default_output_low_risk_action', 'pass') or 'pass'
            ),
            # Data leakage - Output policy - overrides
            output_high_risk_action_override=getattr(app_policy, 'output_high_risk_action', None),
            output_medium_risk_action_override=getattr(app_policy, 'output_medium_risk_action', None),
            output_low_risk_action_override=getattr(app_policy, 'output_low_risk_action', None),
            # Private model
            private_model=PrivateModelBrief.from_orm(private_model) if private_model else None,
            private_model_override=str(app_policy.private_model_id) if app_policy.private_model_id else None,
            available_private_models=[PrivateModelBrief.from_orm(m) for m in available_models],
            created_at=app_policy.created_at,
            updated_at=app_policy.updated_at
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting gateway policy: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error getting gateway policy: {str(e)}")


@router.put("/gateway-policy", response_model=GatewayPolicyResponse)
async def update_gateway_policy(
    request: Request,
    policy_update: GatewayPolicyUpdate,
    db: Session = Depends(get_admin_db),
    application_id: UUID = Depends(get_application_id)
):
    """
    Update gateway security policy for specific application.
    Set to NULL to inherit from tenant defaults.
    """
    try:
        current_user = get_current_user(request)
        tenant_id = UUID(current_user['tenant_id'])

        # Get or create app policy
        app_policy = db.query(ApplicationDataLeakagePolicy).filter(
            ApplicationDataLeakagePolicy.application_id == application_id
        ).first()

        if not app_policy:
            app_policy = ApplicationDataLeakagePolicy(
                tenant_id=tenant_id,
                application_id=application_id
            )
            db.add(app_policy)

        # Update general risk policy - input
        if hasattr(app_policy, 'general_input_high_risk_action'):
            app_policy.general_input_high_risk_action = policy_update.general_input_high_risk_action
        if hasattr(app_policy, 'general_input_medium_risk_action'):
            app_policy.general_input_medium_risk_action = policy_update.general_input_medium_risk_action
        if hasattr(app_policy, 'general_input_low_risk_action'):
            app_policy.general_input_low_risk_action = policy_update.general_input_low_risk_action

        # Update general risk policy - output
        if hasattr(app_policy, 'general_output_high_risk_action'):
            app_policy.general_output_high_risk_action = policy_update.general_output_high_risk_action
        if hasattr(app_policy, 'general_output_medium_risk_action'):
            app_policy.general_output_medium_risk_action = policy_update.general_output_medium_risk_action
        if hasattr(app_policy, 'general_output_low_risk_action'):
            app_policy.general_output_low_risk_action = policy_update.general_output_low_risk_action

        # Update data leakage - input policy
        app_policy.input_high_risk_action = policy_update.input_high_risk_action
        app_policy.input_medium_risk_action = policy_update.input_medium_risk_action
        app_policy.input_low_risk_action = policy_update.input_low_risk_action

        # Update data leakage - output policy
        if hasattr(app_policy, 'output_high_risk_action'):
            app_policy.output_high_risk_action = policy_update.output_high_risk_action
        if hasattr(app_policy, 'output_medium_risk_action'):
            app_policy.output_medium_risk_action = policy_update.output_medium_risk_action
        if hasattr(app_policy, 'output_low_risk_action'):
            app_policy.output_low_risk_action = policy_update.output_low_risk_action

        # Update private model
        if policy_update.private_model_id:
            app_policy.private_model_id = UUID(policy_update.private_model_id)
        else:
            app_policy.private_model_id = None

        db.commit()
        db.refresh(app_policy)

        # Re-fetch with resolved values
        return await get_gateway_policy(request, db, application_id)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating gateway policy: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error updating gateway policy: {str(e)}")
