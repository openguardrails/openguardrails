from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from typing import Dict
import uuid
from database.connection import get_db
from database.models import Tenant
from services.risk_config_service import RiskConfigService
from services.risk_config_cache import risk_config_cache
from services.admin_service import admin_service
from utils.logger import setup_logger
from utils.auth import verify_token
from pydantic import BaseModel, Field

logger = setup_logger()
router = APIRouter(prefix="/api/v1/config", tags=["Risk type configuration"])

def get_current_user_from_request(request: Request, db: Session) -> Tenant:
    """Get current user from request (support user switch)"""
    # 1) Priority check if there is user switch session
    switch_token = request.headers.get('x-switch-session')
    if switch_token:
        switched_user = admin_service.get_switched_user(db, switch_token)
        if switched_user:
            return switched_user

    # 2) Get user from auth context
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context or 'data' not in auth_context:
        raise HTTPException(status_code=401, detail="Not authenticated")

    data = auth_context['data']
    tenant_id_value = data.get('tenant_id')
    user_email_value = data.get('email')

    # 2a) Try to parse tenant_id as UUID and query
    if tenant_id_value:
        try:
            tenant_uuid = uuid.UUID(str(tenant_id_value))
            user = db.query(Tenant).filter(Tenant.id == tenant_uuid).first()
            if user:
                return user
        except ValueError:
            pass

    # 2b) Fall back to using email find
    if user_email_value:
        user = db.query(Tenant).filter(Tenant.email == user_email_value).first()
        if user:
            return user

    # 2c) Last resort: parse JWT in Authorization header, try again
    auth_header = request.headers.get('authorization') or request.headers.get('Authorization')
    if auth_header and auth_header.startswith('Bearer '):
        token = auth_header.split(' ', 1)[1]
        try:
            payload = verify_token(token)
            raw_tenant_id = payload.get('tenant_id') or payload.get('sub')
            if raw_tenant_id:
                try:
                    tenant_uuid = uuid.UUID(str(raw_tenant_id))
                    user = db.query(Tenant).filter(Tenant.id == tenant_uuid).first()
                    if user:
                        return user
                except ValueError:
                    pass
            email_claim = payload.get('email') or payload.get('username')
            if email_claim:
                user = db.query(Tenant).filter(Tenant.email == email_claim).first()
                if user:
                    return user
        except Exception:
            pass

    # Unable to locate valid user
    raise HTTPException(status_code=401, detail="User not found or invalid context")

class RiskConfigRequest(BaseModel):
    s1_enabled: bool = True
    s2_enabled: bool = True
    s3_enabled: bool = True
    s4_enabled: bool = True
    s5_enabled: bool = True
    s6_enabled: bool = True
    s7_enabled: bool = True
    s8_enabled: bool = True
    s9_enabled: bool = True
    s10_enabled: bool = True
    s11_enabled: bool = True
    s12_enabled: bool = True

class RiskConfigResponse(BaseModel):
    s1_enabled: bool
    s2_enabled: bool
    s3_enabled: bool
    s4_enabled: bool
    s5_enabled: bool
    s6_enabled: bool
    s7_enabled: bool
    s8_enabled: bool
    s9_enabled: bool
    s10_enabled: bool
    s11_enabled: bool
    s12_enabled: bool

    class Config:
        from_attributes = True

class SensitivityThresholdRequest(BaseModel):
    high_sensitivity_threshold: float = Field(..., ge=0.0, le=1.0)
    medium_sensitivity_threshold: float = Field(..., ge=0.0, le=1.0)
    low_sensitivity_threshold: float = Field(..., ge=0.0, le=1.0)
    sensitivity_trigger_level: str = Field(..., pattern="^(low|medium|high)$")

class SensitivityThresholdResponse(BaseModel):
    high_sensitivity_threshold: float
    medium_sensitivity_threshold: float
    low_sensitivity_threshold: float
    sensitivity_trigger_level: str

    class Config:
        from_attributes = True

@router.get("/risk-types", response_model=RiskConfigResponse)
async def get_risk_config(
    request: Request,
    db: Session = Depends(get_db)
):
    """Get user risk type configuration"""
    try:
        current_user = get_current_user_from_request(request, db)
        risk_service = RiskConfigService(db)
        config_dict = risk_service.get_risk_config_dict(str(current_user.id))
        return RiskConfigResponse(**config_dict)
    except Exception as e:
        logger.error(f"Failed to get risk config: {e}")
        raise HTTPException(status_code=500, detail="Failed to get risk config")

@router.put("/risk-types", response_model=RiskConfigResponse)
async def update_risk_config(
    config_request: RiskConfigRequest,
    request: Request,
    db: Session = Depends(get_db)
):
    """Update user risk type configuration"""
    try:
        current_user = get_current_user_from_request(request, db)
        risk_service = RiskConfigService(db)
        config_data = config_request.dict()

        updated_config = risk_service.update_risk_config(str(current_user.id), config_data)
        if not updated_config:
            raise HTTPException(status_code=500, detail="Failed to update risk config")
        
        # Clear the user's cache, force reload
        await risk_config_cache.invalidate_user_cache(str(current_user.id))

        # Return updated configuration
        config_dict = risk_service.get_risk_config_dict(str(current_user.id))
        logger.info(f"Updated risk config for user {current_user.id}")
        
        return RiskConfigResponse(**config_dict)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update risk config: {e}")
        raise HTTPException(status_code=500, detail="Failed to update risk config")

@router.get("/risk-types/enabled", response_model=Dict[str, bool])
async def get_enabled_risk_types(
    request: Request,
    db: Session = Depends(get_db)
):
    """Get user enabled risk type mapping"""
    try:
        current_user = get_current_user_from_request(request, db)
        risk_service = RiskConfigService(db)
        enabled_types = risk_service.get_enabled_risk_types(str(current_user.id))
        return enabled_types
    except Exception as e:
        logger.error(f"Failed to get enabled risk types: {e}")
        raise HTTPException(status_code=500, detail="Failed to get enabled risk types")

@router.post("/risk-types/reset")
async def reset_risk_config(
    request: Request,
    db: Session = Depends(get_db)
):
    """Reset risk type configuration to default (all enabled)"""
    try:
        current_user = get_current_user_from_request(request, db)
        risk_service = RiskConfigService(db)
        default_config = {
            's1_enabled': True, 's2_enabled': True, 's3_enabled': True, 's4_enabled': True,
            's5_enabled': True, 's6_enabled': True, 's7_enabled': True, 's8_enabled': True,
            's9_enabled': True, 's10_enabled': True, 's11_enabled': True, 's12_enabled': True
        }

        updated_config = risk_service.update_risk_config(str(current_user.id), default_config)
        if not updated_config:
            raise HTTPException(status_code=500, detail="Failed to reset risk config")

        # Clear the user's cache
        await risk_config_cache.invalidate_user_cache(str(current_user.id))

        logger.info(f"Reset risk config to default for user {current_user.id}")
        return {"message": "Risk config has been reset to default"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to reset risk config: {e}")
        raise HTTPException(status_code=500, detail="Failed to reset risk config")

@router.get("/sensitivity-thresholds", response_model=SensitivityThresholdResponse)
async def get_sensitivity_thresholds(
    request: Request,
    db: Session = Depends(get_db)
):
    """Get user sensitivity threshold configuration"""
    try:
        current_user = get_current_user_from_request(request, db)
        risk_service = RiskConfigService(db)
        config_dict = risk_service.get_sensitivity_threshold_dict(str(current_user.id))
        return SensitivityThresholdResponse(**config_dict)
    except Exception as e:
        logger.error(f"Failed to get sensitivity thresholds: {e}")
        raise HTTPException(status_code=500, detail="Failed to get sensitivity thresholds")

@router.put("/sensitivity-thresholds", response_model=SensitivityThresholdResponse)
async def update_sensitivity_thresholds(
    threshold_request: SensitivityThresholdRequest,
    request: Request,
    db: Session = Depends(get_db)
):
    """Update user sensitivity threshold configuration"""
    try:
        current_user = get_current_user_from_request(request, db)
        risk_service = RiskConfigService(db)
        threshold_data = threshold_request.dict()

        updated_config = risk_service.update_sensitivity_thresholds(str(current_user.id), threshold_data)
        if not updated_config:
            raise HTTPException(status_code=500, detail="Failed to update sensitivity thresholds")

        # Clear the user's sensitivity cache, force reload
        await risk_config_cache.invalidate_sensitivity_cache(str(current_user.id))

        # Return updated configuration
        config_dict = risk_service.get_sensitivity_threshold_dict(str(current_user.id))
        logger.info(f"Updated sensitivity thresholds for user {current_user.id}")

        return SensitivityThresholdResponse(**config_dict)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update sensitivity thresholds: {e}")
        raise HTTPException(status_code=500, detail="Failed to update sensitivity thresholds")

@router.post("/sensitivity-thresholds/reset")
async def reset_sensitivity_thresholds(
    request: Request,
    db: Session = Depends(get_db)
):
    """Reset sensitivity threshold configuration to default"""
    try:
        current_user = get_current_user_from_request(request, db)
        risk_service = RiskConfigService(db)
        default_config = {
            'high_sensitivity_threshold': 0.40,
            'medium_sensitivity_threshold': 0.60,
            'low_sensitivity_threshold': 0.95,
            'sensitivity_trigger_level': 'medium'
        }

        updated_config = risk_service.update_sensitivity_thresholds(str(current_user.id), default_config)
        if not updated_config:
            raise HTTPException(status_code=500, detail="Failed to reset sensitivity thresholds")

        # Clear the user's sensitivity cache
        await risk_config_cache.invalidate_sensitivity_cache(str(current_user.id))

        logger.info(f"Reset sensitivity thresholds to default for user {current_user.id}")
        return {"message": "Sensitivity thresholds have been reset to default"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to reset sensitivity thresholds: {e}")
        raise HTTPException(status_code=500, detail="Failed to reset sensitivity thresholds")