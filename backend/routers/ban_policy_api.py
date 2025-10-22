"""
Ban policy API routes
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from typing import Optional, List
from services.ban_policy_service import BanPolicyService
import logging

def get_current_tenant_id(request: Request) -> str:
    """Get current tenant ID from request context"""
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context:
        raise HTTPException(status_code=401, detail="Not authenticated")

    tenant_id = str(auth_context['data'].get('tenant_id'))
    if not tenant_id:
        raise HTTPException(status_code=401, detail="Tenant ID not found in auth context")

    return tenant_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/ban-policy", tags=["ban-policy"])


class BanPolicyUpdate(BaseModel):
    """Ban policy update model"""
    enabled: bool = Field(False, description="Whether to enable ban policy")
    risk_level: str = Field("high_risk", description="Minimum risk level to trigger ban", pattern="^(high_risk|medium_risk|low_risk)$")
    trigger_count: int = Field(3, ge=1, le=100, description="Trigger count threshold")
    time_window_minutes: int = Field(10, ge=1, le=1440, description="Time window (minutes)")
    ban_duration_minutes: int = Field(60, ge=1, le=10080, description="Ban duration (minutes)")


class UnbanUserRequest(BaseModel):
    """Unban user request model"""
    user_id: str = Field(..., description="User ID to unban")


@router.get("")
async def get_ban_policy(tenant_id: str = Depends(get_current_tenant_id)):
    """Get current tenant's ban policy configuration"""
    try:
        policy = await BanPolicyService.get_ban_policy(tenant_id)

        if not policy:
            # If no policy, return default values
            return {
                "enabled": False,
                "risk_level": "high_risk",
                "trigger_count": 3,
                "time_window_minutes": 10,
                "ban_duration_minutes": 60
            }

        return policy

    except Exception as e:
        logger.error(f"Failed to get ban policy: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get ban policy: {str(e)}")


@router.put("")
async def update_ban_policy(
    policy_data: BanPolicyUpdate,
    tenant_id: str = Depends(get_current_tenant_id)
):
    """Update ban policy configuration"""
    try:
        policy = await BanPolicyService.update_ban_policy(
            tenant_id,
            policy_data.dict()
        )

        return {
            "success": True,
            "message": "Ban policy updated",
            "policy": policy
        }

    except Exception as e:
        logger.error(f"Failed to update ban policy: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to update ban policy: {str(e)}")


@router.get("/templates")
async def get_ban_policy_templates():
    """Get ban policy preset templates"""
    return {
        "templates": [
            {
                "name": "Strict mode",
                "description": "High security requirements",
                "enabled": True,
                "risk_level": "high_risk",
                "trigger_count": 3,
                "time_window_minutes": 10,
                "ban_duration_minutes": 60
            },
            {
                "name": "Standard mode",
                "description": "Balance security and user experience",
                "enabled": True,
                "risk_level": "high_risk",
                "trigger_count": 5,
                "time_window_minutes": 30,
                "ban_duration_minutes": 30
            },
            {
                "name": "Relaxed mode",
                "description": "Test or low risk scenarios",
                "enabled": True,
                "risk_level": "high_risk",
                "trigger_count": 10,
                "time_window_minutes": 60,
                "ban_duration_minutes": 15
            },
            {
                "name": "Disabled",
                "description": "Disable ban policy",
                "enabled": False,
                "risk_level": "high_risk",
                "trigger_count": 3,
                "time_window_minutes": 10,
                "ban_duration_minutes": 60
            }
        ]
    }


@router.get("/banned-users")
async def get_banned_users(
    skip: int = Query(0, ge=0, description="Number of records to skip"),
    limit: int = Query(100, ge=1, le=1000, description="Maximum number of records to return"),
    tenant_id: str = Depends(get_current_tenant_id)
):
    """Get list of banned users"""
    try:
        users = await BanPolicyService.get_banned_users(
            tenant_id,
            skip=skip,
            limit=limit
        )

        return {"users": users}

    except Exception as e:
        logger.error(f"Failed to get banned users: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get banned users: {str(e)}")


@router.post("/unban")
async def unban_user(
    request: UnbanUserRequest,
    tenant_id: str = Depends(get_current_tenant_id)
):
    """Manually unban user"""
    try:
        success = await BanPolicyService.unban_user(tenant_id, request.user_id)

        if success:
            return {
                "success": True,
                "message": f"User {request.user_id} has been unbanned"
            }
        else:
            return {
                "success": False,
                "message": f"User {request.user_id} is not banned or has already been unbanned"
            }

    except Exception as e:
        logger.error(f"Failed to unban user: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to unban user: {str(e)}")


@router.get("/user-history/{user_id}")
async def get_user_risk_history(
    user_id: str,
    days: int = Query(7, ge=1, le=30, description="Number of days to query"),
    tenant_id: str = Depends(get_current_tenant_id)
):
    """Get user risk trigger history"""
    try:
        history = await BanPolicyService.get_user_risk_history(
            tenant_id,
            user_id,
            days=days
        )

        return {
            "user_id": user_id,
            "days": days,
            "total": len(history),
            "history": history
        }

    except Exception as e:
        logger.error(f"Failed to get user risk history: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to get user risk history: {str(e)}")


@router.get("/check-status/{user_id}")
async def check_user_ban_status(
    user_id: str,
    tenant_id: str = Depends(get_current_tenant_id)
):
    """Check user ban status"""
    try:
        ban_record = await BanPolicyService.check_user_banned(tenant_id, user_id)

        if ban_record:
            return {
                "is_banned": True,
                "ban_record": ban_record
            }
        else:
            return {
                "is_banned": False,
                "ban_record": None
            }

    except Exception as e:
        logger.error(f"Failed to check user ban status: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to check user ban status: {str(e)}")
