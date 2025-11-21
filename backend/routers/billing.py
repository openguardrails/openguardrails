"""
Billing Router - Subscription and usage management APIs
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from database.connection import get_admin_db
from services.billing_service import billing_service
from services.admin_service import admin_service
from database.models import Tenant
from utils.logger import setup_logger
import uuid

logger = setup_logger()
router = APIRouter(tags=["Billing"])


def get_current_user(request: Request, db: Session) -> Tenant:
    """Get current tenant from request context or JWT token"""
    # First try to get from request.state.auth_context (set by middleware)
    auth_context = getattr(request.state, 'auth_context', None)

    if auth_context:
        data = auth_context['data']
        tenant_id = str(data.get('tenant_id'))
        if tenant_id:
            try:
                tenant_uuid = uuid.UUID(tenant_id)
                tenant = db.query(Tenant).filter(Tenant.id == tenant_uuid).first()
                if tenant:
                    return tenant
            except (ValueError, AttributeError):
                pass

    # If not found in auth_context, try JWT token from Authorization header
    from utils.auth import verify_token
    auth_header = request.headers.get('Authorization')

    if not auth_header or not auth_header.startswith('Bearer '):
        raise HTTPException(status_code=401, detail="Not authenticated")

    token = auth_header.replace('Bearer ', '')

    try:
        payload = verify_token(token)
        email = payload.get('sub')

        if not email:
            raise HTTPException(status_code=401, detail="Invalid token")

        tenant = db.query(Tenant).filter(Tenant.email == email).first()
        if not tenant:
            raise HTTPException(status_code=401, detail="Tenant not found")

        if not tenant.is_active or not tenant.is_verified:
            raise HTTPException(status_code=403, detail="Tenant account not active")

        return tenant

    except Exception as e:
        logger.error(f"Token verification failed: {e}")
        raise HTTPException(status_code=401, detail="Invalid credentials")


# Response models
class SubscriptionResponse(BaseModel):
    id: str
    tenant_id: str
    subscription_type: str
    monthly_quota: int
    current_month_usage: int
    usage_reset_at: str
    usage_percentage: float
    plan_name: str


class UpdateSubscriptionRequest(BaseModel):
    subscription_type: str  # 'free' or 'subscribed'


# User-facing APIs
@router.get("/api/v1/billing/subscription", response_model=SubscriptionResponse)
async def get_my_subscription(
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Get current tenant's subscription information"""
    try:
        current_tenant = get_current_user(request, db)
        tenant_id = str(current_tenant.id)

        subscription_info = billing_service.get_subscription_with_usage(tenant_id, db)

        if not subscription_info:
            raise HTTPException(
                status_code=404,
                detail="Subscription not found. Please contact support."
            )

        return SubscriptionResponse(**subscription_info)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get subscription: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.get("/api/v1/billing/usage")
async def get_my_usage(
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Get current tenant's usage statistics"""
    try:
        current_tenant = get_current_user(request, db)
        tenant_id = str(current_tenant.id)

        subscription_info = billing_service.get_subscription_with_usage(tenant_id, db)

        if not subscription_info:
            raise HTTPException(
                status_code=404,
                detail="Subscription not found. Please contact support."
            )

        return {
            "status": "success",
            "data": {
                "current_month_usage": subscription_info['current_month_usage'],
                "monthly_quota": subscription_info['monthly_quota'],
                "usage_percentage": subscription_info['usage_percentage'],
                "remaining": subscription_info['monthly_quota'] - subscription_info['current_month_usage'],
                "usage_reset_at": subscription_info['usage_reset_at'],
                "subscription_type": subscription_info['subscription_type'],
                "plan_name": subscription_info['plan_name']
            }
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get usage: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


# Admin APIs
@router.get("/api/v1/admin/billing/subscriptions")
async def list_all_subscriptions(
    request: Request,
    skip: int = 0,
    limit: int = 100,
    search: Optional[str] = None,
    subscription_type: Optional[str] = None,
    sort_by: Optional[str] = 'current_month_usage',
    sort_order: Optional[str] = 'desc',
    db: Session = Depends(get_admin_db)
):
    """List all tenant subscriptions (admin only)"""
    try:
        current_tenant = get_current_user(request, db)

        if not admin_service.is_super_admin(current_tenant):
            raise HTTPException(
                status_code=403,
                detail="Access denied: Super admin required"
            )

        results, total = billing_service.list_subscriptions(
            db, skip, limit, search, subscription_type, sort_by, sort_order
        )

        return {
            "status": "success",
            "data": results,
            "total": total,
            "skip": skip,
            "limit": limit
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to list subscriptions: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.put("/api/v1/admin/billing/subscriptions/{tenant_id}")
async def update_tenant_subscription(
    tenant_id: str,
    request_data: UpdateSubscriptionRequest,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Update tenant subscription type (admin only)"""
    try:
        current_tenant = get_current_user(request, db)

        if not admin_service.is_super_admin(current_tenant):
            raise HTTPException(
                status_code=403,
                detail="Access denied: Super admin required"
            )

        # Validate subscription type
        if request_data.subscription_type not in ['free', 'subscribed']:
            raise HTTPException(
                status_code=400,
                detail="Invalid subscription type. Must be 'free' or 'subscribed'"
            )

        # Update subscription
        subscription = billing_service.update_subscription_type(
            tenant_id,
            request_data.subscription_type,
            db
        )

        return {
            "status": "success",
            "message": f"Subscription updated to {request_data.subscription_type}",
            "data": {
                "tenant_id": str(subscription.tenant_id),
                "subscription_type": subscription.subscription_type,
                "monthly_quota": subscription.monthly_quota
            }
        }

    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to update subscription: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/api/v1/admin/billing/subscriptions/{tenant_id}/reset-quota")
async def reset_tenant_quota(
    tenant_id: str,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Manually reset tenant's monthly quota (admin only)"""
    try:
        current_tenant = get_current_user(request, db)

        if not admin_service.is_super_admin(current_tenant):
            raise HTTPException(
                status_code=403,
                detail="Access denied: Super admin required"
            )

        subscription = billing_service.reset_monthly_quota(tenant_id, db)

        return {
            "status": "success",
            "message": f"Quota reset for tenant {tenant_id}",
            "data": {
                "tenant_id": str(subscription.tenant_id),
                "current_month_usage": subscription.current_month_usage,
                "monthly_quota": subscription.monthly_quota,
                "usage_reset_at": subscription.usage_reset_at.isoformat()
            }
        }

    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to reset quota: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@router.post("/api/v1/admin/billing/reset-all-quotas")
async def reset_all_quotas(
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """Reset all tenants' monthly quotas (admin only, for scheduled tasks)"""
    try:
        current_tenant = get_current_user(request, db)

        if not admin_service.is_super_admin(current_tenant):
            raise HTTPException(
                status_code=403,
                detail="Access denied: Super admin required"
            )

        reset_count = billing_service.reset_all_quotas(db)

        return {
            "status": "success",
            "message": f"Reset quotas for {reset_count} tenants",
            "data": {
                "reset_count": reset_count
            }
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to reset all quotas: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")
