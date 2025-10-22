from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session
from database.connection import get_db
from services.stats_service import StatsService
from models.responses import DashboardStats
from utils.logger import setup_logger
from config import settings
from typing import Optional

logger = setup_logger()
router = APIRouter(tags=["Dashboard"])

def get_current_tenant_id(request: Request) -> str:
    """Get current user ID from request context"""
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context:
        raise HTTPException(status_code=401, detail="Not authenticated")
    
    tenant_id = str(auth_context['data'].get('tenant_id'))
    if not tenant_id:
        raise HTTPException(status_code=401, detail="User ID not found in auth context")
    
    return tenant_id

@router.get("/dashboard/stats", response_model=DashboardStats)
async def get_dashboard_stats(request: Request, db: Session = Depends(get_db)):
    """Get dashboard stats"""
    try:
        current_tenant_id = get_current_tenant_id(request)
        
        stats_service = StatsService(db)
        stats = stats_service.get_dashboard_stats(tenant_id=current_tenant_id)
        
        logger.info(f"Dashboard stats retrieved successfully for user {current_tenant_id}")
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
        current_tenant_id = get_current_tenant_id(request)
        
        stats_service = StatsService(db) 
        category_data = stats_service.get_category_distribution(start_date, end_date, tenant_id=current_tenant_id)
        
        logger.info(f"Category distribution retrieved successfully for user {current_tenant_id}")
        return {"categories": category_data}
        
    except Exception as e:
        logger.error(f"Category distribution error: {e}")
        raise HTTPException(status_code=500, detail="Failed to get category distribution")