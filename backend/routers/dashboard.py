from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session
from database.connection import get_admin_db
from database.models import Tenant, Application
from services.stats_service import StatsService
from models.responses import DashboardStats
from utils.logger import setup_logger
from config import settings
from typing import Optional, Tuple
import uuid

logger = setup_logger()
router = APIRouter(tags=["Dashboard"])

def get_current_tenant_and_optional_application(request: Request, db: Session) -> Tuple[Tenant, Optional[uuid.UUID]]:
    """
    Get current tenant and optional application_id from request.
    Returns: (Tenant, application_id or None)
    application_id is only set when explicitly provided via X-Application-ID header.
    When None, dashboard shows all data for the tenant.
    """
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context or 'data' not in auth_context:
        raise HTTPException(status_code=401, detail="Not authenticated")

    data = auth_context['data']

    tenant_id = data.get('tenant_id')
    if not tenant_id:
        raise HTTPException(status_code=401, detail="Tenant ID not found in auth context")

    try:
        tenant_uuid = uuid.UUID(str(tenant_id))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid tenant ID format")

    tenant = db.query(Tenant).filter(Tenant.id == tenant_uuid).first()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    # Only filter by application when explicitly selected via header
    header_app_id = request.headers.get('x-application-id') or request.headers.get('X-Application-ID')
    if header_app_id:
        try:
            header_app_uuid = uuid.UUID(str(header_app_id))
            app = db.query(Application).filter(
                Application.id == header_app_uuid,
                Application.tenant_id == tenant.id,
                Application.is_active == True
            ).first()
            if app:
                return tenant, header_app_uuid
        except (ValueError, AttributeError):
            pass

    # No explicit application selected - return None to show all tenant data
    return tenant, None

@router.get("/dashboard/stats", response_model=DashboardStats)
async def get_dashboard_stats(request: Request, db: Session = Depends(get_admin_db)):
    """Get dashboard stats - shows all data for the tenant (org-level view)"""
    try:
        current_user, application_id = get_current_tenant_and_optional_application(request, db)

        stats_service = StatsService(db)
        stats = stats_service.get_dashboard_stats(tenant_id=current_user.id, application_id=application_id)

        logger.info(f"Dashboard stats retrieved successfully for tenant {current_user.id}, application {application_id}")
        return DashboardStats(**stats)

    except Exception as e:
        logger.error(f"Dashboard stats error: {e}")
        raise HTTPException(status_code=500, detail="Failed to get dashboard stats")

@router.get("/dashboard/category-distribution")
async def get_category_distribution(
    request: Request,
    start_date: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    end_date: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    tz_offset: Optional[int] = Query(None, description="Client timezone offset in minutes"),
    db: Session = Depends(get_admin_db)
):
    """Get risk category distribution stats"""
    try:
        current_user, application_id = get_current_tenant_and_optional_application(request, db)

        stats_service = StatsService(db)
        category_data = stats_service.get_category_distribution(start_date, end_date, tenant_id=current_user.id, application_id=application_id, tz_offset=tz_offset)

        logger.info(f"Category distribution retrieved successfully for tenant {current_user.id}, application {application_id}")
        return {"categories": category_data}

    except Exception as e:
        logger.error(f"Category distribution error: {e}")
        raise HTTPException(status_code=500, detail="Failed to get category distribution")