from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from typing import Dict, Tuple
import uuid
from database.connection import get_admin_db
from database.models import Tenant, Application
from services.risk_config_service import RiskConfigService
from services.risk_config_cache import risk_config_cache
from services.admin_service import admin_service
from utils.logger import setup_logger
from utils.auth import verify_token
from pydantic import BaseModel, Field

logger = setup_logger()
router = APIRouter(prefix="/api/v1/config", tags=["Risk type configuration"])

def get_current_user_and_application_from_request(request: Request, db: Session) -> Tuple[Tenant, uuid.UUID]:
    """
    Get current tenant and application_id from request
    Returns: (Tenant, application_id)
    """
    # 0) Check for X-Application-ID header (highest priority - from frontend selector)
    header_app_id = request.headers.get('x-application-id') or request.headers.get('X-Application-ID')
    if header_app_id:
        try:
            header_app_uuid = uuid.UUID(str(header_app_id))
            app = db.query(Application).filter(
                Application.id == header_app_uuid,
                Application.is_active == True
            ).first()
            if app:
                tenant = db.query(Tenant).filter(Tenant.id == app.tenant_id).first()
                if tenant:
                    return tenant, header_app_uuid
        except (ValueError, AttributeError):
            pass

    # 1) Priority check if there is user switch session
    switch_token = request.headers.get('x-switch-session')
    if switch_token:
        switched_user = admin_service.get_switched_user(db, switch_token)
        if switched_user:
            # For switched sessions, use the default application
            default_app = db.query(Application).filter(
                Application.tenant_id == switched_user.id,
                Application.is_active == True
            ).first()
            if not default_app:
                raise HTTPException(status_code=404, detail="No active application found for switched user")
            return switched_user, default_app.id

    # 2) Get user and application from auth context
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context or 'data' not in auth_context:
        raise HTTPException(status_code=401, detail="Not authenticated")

    data = auth_context['data']

    # Extract application_id first (priority)
    application_id_value = data.get('application_id')
    if application_id_value:
        try:
            application_uuid = uuid.UUID(str(application_id_value))
            # Verify application exists and get its tenant
            app = db.query(Application).filter(Application.id == application_uuid, Application.is_active == True).first()
            if app:
                tenant = db.query(Tenant).filter(Tenant.id == app.tenant_id).first()
                if tenant:
                    return tenant, application_uuid
        except (ValueError, AttributeError):
            pass

    # Fallback: get tenant and use their default application
    tenant_id_value = data.get('tenant_id')
    user_email_value = data.get('email')

    tenant = None

    # Try to find tenant by ID
    if tenant_id_value:
        try:
            tenant_uuid = uuid.UUID(str(tenant_id_value))
            tenant = db.query(Tenant).filter(Tenant.id == tenant_uuid).first()
        except ValueError:
            pass

    # Fall back to email
    if not tenant and user_email_value:
        tenant = db.query(Tenant).filter(Tenant.email == user_email_value).first()

    # Last resort: parse JWT
    if not tenant:
        auth_header = request.headers.get('authorization') or request.headers.get('Authorization')
        if auth_header and auth_header.startswith('Bearer '):
            token = auth_header.split(' ', 1)[1]
            try:
                payload = verify_token(token)
                raw_tenant_id = payload.get('tenant_id') or payload.get('sub')
                if raw_tenant_id:
                    try:
                        tenant_uuid = uuid.UUID(str(raw_tenant_id))
                        tenant = db.query(Tenant).filter(Tenant.id == tenant_uuid).first()
                    except ValueError:
                        pass
                if not tenant:
                    email_claim = payload.get('email') or payload.get('username')
                    if email_claim:
                        tenant = db.query(Tenant).filter(Tenant.email == email_claim).first()
            except Exception:
                pass

    if not tenant:
        raise HTTPException(status_code=401, detail="User not found or invalid context")

    # Get default application for this tenant
    default_app = db.query(Application).filter(
        Application.tenant_id == tenant.id,
        Application.is_active == True
    ).first()

    if not default_app:
        raise HTTPException(status_code=404, detail="No active application found for user")

    return tenant, default_app.id

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
    s13_enabled: bool = True
    s14_enabled: bool = True
    s15_enabled: bool = True
    s16_enabled: bool = True
    s17_enabled: bool = True
    s18_enabled: bool = True
    s19_enabled: bool = True
    s20_enabled: bool = True
    s21_enabled: bool = True

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
    s13_enabled: bool
    s14_enabled: bool
    s15_enabled: bool
    s16_enabled: bool
    s17_enabled: bool
    s18_enabled: bool
    s19_enabled: bool
    s20_enabled: bool
    s21_enabled: bool

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
    db: Session = Depends(get_admin_db)
):
    """Get application risk type configuration"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        risk_service = RiskConfigService(db)
        config_dict = risk_service.get_risk_config_dict(application_id=str(application_id))
        return RiskConfigResponse(**config_dict)
    except Exception as e:
        logger.error(f"Failed to get risk config: {e}")
        raise HTTPException(status_code=500, detail="Failed to get risk config")

@router.put("/risk-types", response_model=RiskConfigResponse)
async def update_risk_config(
    config_request: RiskConfigRequest,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Update application risk type configuration"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        risk_service = RiskConfigService(db)
        config_data = config_request.dict()

        updated_config = risk_service.update_risk_config(application_id=str(application_id), config_data=config_data)
        if not updated_config:
            raise HTTPException(status_code=500, detail="Failed to update risk config")

        # Clear the application's cache, force reload
        await risk_config_cache.invalidate_user_cache(application_id=str(application_id))

        # Return updated configuration
        config_dict = risk_service.get_risk_config_dict(application_id=str(application_id))
        logger.info(f"Updated risk config for application {application_id}")

        return RiskConfigResponse(**config_dict)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update risk config: {e}")
        raise HTTPException(status_code=500, detail="Failed to update risk config")

@router.get("/risk-types/enabled", response_model=Dict[str, bool])
async def get_enabled_risk_types(
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Get application enabled risk type mapping"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        risk_service = RiskConfigService(db)
        enabled_types = risk_service.get_enabled_risk_types(application_id=str(application_id))
        return enabled_types
    except Exception as e:
        logger.error(f"Failed to get enabled risk types: {e}")
        raise HTTPException(status_code=500, detail="Failed to get enabled risk types")

@router.post("/risk-types/reset")
async def reset_risk_config(
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Reset risk type configuration to default (all enabled)"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        risk_service = RiskConfigService(db)
        default_config = {
            's1_enabled': True, 's2_enabled': True, 's3_enabled': True, 's4_enabled': True,
            's5_enabled': True, 's6_enabled': True, 's7_enabled': True, 's8_enabled': True,
            's9_enabled': True, 's10_enabled': True, 's11_enabled': True, 's12_enabled': True,
            's13_enabled': True, 's14_enabled': True, 's15_enabled': True, 's16_enabled': True,
            's17_enabled': True, 's18_enabled': True, 's19_enabled': True, 's20_enabled': True,
            's21_enabled': True
        }

        updated_config = risk_service.update_risk_config(application_id=str(application_id), config_data=default_config)
        if not updated_config:
            raise HTTPException(status_code=500, detail="Failed to reset risk config")

        # Clear the application's cache
        await risk_config_cache.invalidate_user_cache(application_id=str(application_id))

        logger.info(f"Reset risk config to default for application {application_id}")
        return {"message": "Risk config has been reset to default"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to reset risk config: {e}")
        raise HTTPException(status_code=500, detail="Failed to reset risk config")

@router.get("/sensitivity-thresholds", response_model=SensitivityThresholdResponse)
async def get_sensitivity_thresholds(
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Get application sensitivity threshold configuration"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        risk_service = RiskConfigService(db)
        config_dict = risk_service.get_sensitivity_threshold_dict(application_id=str(application_id))
        return SensitivityThresholdResponse(**config_dict)
    except Exception as e:
        logger.error(f"Failed to get sensitivity thresholds: {e}")
        raise HTTPException(status_code=500, detail="Failed to get sensitivity thresholds")

@router.put("/sensitivity-thresholds", response_model=SensitivityThresholdResponse)
async def update_sensitivity_thresholds(
    threshold_request: SensitivityThresholdRequest,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Update application sensitivity threshold configuration"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        risk_service = RiskConfigService(db)
        threshold_data = threshold_request.dict()

        updated_config = risk_service.update_sensitivity_thresholds(application_id=str(application_id), threshold_data=threshold_data)
        if not updated_config:
            raise HTTPException(status_code=500, detail="Failed to update sensitivity thresholds")

        # Clear the application's sensitivity cache, force reload
        await risk_config_cache.invalidate_sensitivity_cache(application_id=str(application_id))

        # Return updated configuration
        config_dict = risk_service.get_sensitivity_threshold_dict(application_id=str(application_id))
        logger.info(f"Updated sensitivity thresholds for application {application_id}")

        return SensitivityThresholdResponse(**config_dict)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update sensitivity thresholds: {e}")
        raise HTTPException(status_code=500, detail="Failed to update sensitivity thresholds")

@router.post("/sensitivity-thresholds/reset")
async def reset_sensitivity_thresholds(
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Reset sensitivity threshold configuration to default"""
    try:
        current_user, application_id = get_current_user_and_application_from_request(request, db)
        risk_service = RiskConfigService(db)
        default_config = {
            'high_sensitivity_threshold': 0.40,
            'medium_sensitivity_threshold': 0.60,
            'low_sensitivity_threshold': 0.95,
            'sensitivity_trigger_level': 'medium'
        }

        updated_config = risk_service.update_sensitivity_thresholds(application_id=str(application_id), threshold_data=default_config)
        if not updated_config:
            raise HTTPException(status_code=500, detail="Failed to reset sensitivity thresholds")

        # Clear the application's sensitivity cache
        await risk_config_cache.invalidate_sensitivity_cache(application_id=str(application_id))

        logger.info(f"Reset sensitivity thresholds to default for application {application_id}")
        return {"message": "Sensitivity thresholds have been reset to default"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to reset sensitivity thresholds: {e}")
        raise HTTPException(status_code=500, detail="Failed to reset sensitivity thresholds")