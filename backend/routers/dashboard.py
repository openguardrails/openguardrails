from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session
from database.connection import get_db
from database.models import Tenant, Application
from services.stats_service import StatsService
from models.responses import DashboardStats
from utils.logger import setup_logger
from config import settings
from typing import Optional, Tuple
import uuid

logger = setup_logger()
router = APIRouter(tags=["Dashboard"])

def get_current_user_and_application_from_request(request: Request, db: Session) -> Tuple[Tenant, uuid.UUID]:
    """
    Get current tenant and application_id from request
    Returns: (Tenant, application_id)
    """
    # First, always get auth context to verify user
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context or 'data' not in auth_context:
        raise HTTPException(status_code=401, detail="Not authenticated")

    data = auth_context['data']

    # Get current user's tenant_id
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

    # 0) Check for X-Application-ID header (highest priority - from frontend selector)
    header_app_id = request.headers.get('x-application-id') or request.headers.get('X-Application-ID')
    if header_app_id:
        try:
            header_app_uuid = uuid.UUID(str(header_app_id))
            app = db.query(Application).filter(
                Application.id == header_app_uuid,
                Application.tenant_id == tenant.id,  # Must belong to current user's tenant
                Application.is_active == True
            ).first()
            if app:
                return tenant, header_app_uuid
        except (ValueError, AttributeError):
            pass

    # 1) Check application_id in auth token (from API call with specific application)
    application_id_value = data.get('application_id')
    if application_id_value:
        try:
            application_uuid = uuid.UUID(str(application_id_value))
            # Verify application exists, is active, and belongs to current tenant
            app = db.query(Application).filter(
                Application.id == application_uuid,
                Application.tenant_id == tenant.id,
                Application.is_active == True
            ).first()
            if app:
                return tenant, application_uuid
        except (ValueError, AttributeError):
            pass

    # 2) Fallback: get default application for this tenant (ordered by creation time)
    default_app = db.query(Application).filter(
        Application.tenant_id == tenant.id,
        Application.is_active == True
    ).order_by(Application.created_at.asc()).first()

    if not default_app:
        raise HTTPException(status_code=404, detail="No active application found for user")

    return tenant, default_app.id

@router.get("/dashboard/stats", response_model=DashboardStats)
async def get_dashboard_stats(request: Request, db: Session = Depends(get_db)):
    """Get dashboard stats"""
    try:
        # Get user and application context
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        stats_service = StatsService(db)
        stats = stats_service.get_dashboard_stats(application_id=application_id)

        logger.info(f"Dashboard stats retrieved successfully for user {current_user.id} and application {application_id}")
        return DashboardStats(**stats)

    except Exception as e:
        logger.error(f"Dashboard stats error: {e}")
        raise HTTPException(status_code=500, detail="Failed to get dashboard stats")

@router.get("/dashboard/category-distribution")
async def get_category_distribution(
    request: Request,
    start_date: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    end_date: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    db: Session = Depends(get_db)
):
    """Get risk category distribution stats"""
    try:
        # Get user and application context
        current_user, application_id = get_current_user_and_application_from_request(request, db)

        stats_service = StatsService(db)
        category_data = stats_service.get_category_distribution(start_date, end_date, application_id=application_id)

        logger.info(f"Category distribution retrieved successfully for user {current_user.id} and application {application_id}")
        return {"categories": category_data}

    except Exception as e:
        logger.error(f"Category distribution error: {e}")
        raise HTTPException(status_code=500, detail="Failed to get category distribution")