"""
Concurrent stats API - Admin view concurrent stats for all services
"""
from fastapi import APIRouter, Depends, HTTPException
from typing import Dict, Any
import asyncio

from middleware.concurrent_limit_middleware import ConcurrentLimitMiddleware
from routers.auth import get_current_admin
from utils.logger import setup_logger

router = APIRouter(prefix="/api/v1/concurrent", tags=["Concurrent stats"])
logger = setup_logger()

@router.get("/stats", summary="Get concurrent stats for all services")
async def get_concurrent_stats(admin_user=Depends(get_current_admin)) -> Dict[str, Any]:
    """
    Get concurrent stats for all services
    Only admin can access this API
    """
    try:
        # Get concurrent stats for all services
        all_stats = ConcurrentLimitMiddleware.get_all_stats()
        
        # Build return data
        result = {
            "services": {},
            "summary": {
                "total_services": len(all_stats),
                "total_current_requests": 0,
                "total_processed_requests": 0,
                "total_rejected_requests": 0
            }
        }
        
        for service_type, stats in all_stats.items():
            result["services"][service_type] = {
                "current_requests": stats["current_requests"],
                "total_requests": stats["total_requests"],
                "rejected_requests": stats["rejected_requests"],
                "max_concurrent_reached": stats["max_concurrent_reached"],
                "success_rate": (stats["total_requests"] - stats["rejected_requests"]) / max(stats["total_requests"], 1) * 100,
                "rejection_rate": stats["rejected_requests"] / max(stats["total_requests"], 1) * 100
            }
            
            # Accumulate stats
            result["summary"]["total_current_requests"] += stats["current_requests"]
            result["summary"]["total_processed_requests"] += stats["total_requests"]
            result["summary"]["total_rejected_requests"] += stats["rejected_requests"]
        
        # Calculate overall success rate
        total_requests = result["summary"]["total_processed_requests"]
        if total_requests > 0:
            result["summary"]["overall_success_rate"] = (total_requests - result["summary"]["total_rejected_requests"]) / total_requests * 100
        else:
            result["summary"]["overall_success_rate"] = 100.0
        
        return result
        
    except Exception as e:
        logger.error(f"Failed to get concurrent stats: {e}")
        raise HTTPException(status_code=500, detail="Failed to get concurrent statistics")

@router.get("/stats/{service_type}", summary="Get concurrent stats for specified service")
async def get_service_concurrent_stats(
    service_type: str, 
    admin_user=Depends(get_current_admin)
) -> Dict[str, Any]:
    """
    Get concurrent stats for specified service
    
    Args:
        service_type: Service type (admin/detection/proxy)
    """
    try:
        if service_type not in ["admin", "detection", "proxy"]:
            raise HTTPException(status_code=400, detail="Invalid service type. Must be one of: admin, detection, proxy")
        
        stats = ConcurrentLimitMiddleware.get_stats(service_type)
        
        if stats is None:
            raise HTTPException(status_code=404, detail=f"No statistics found for service: {service_type}")
        
        # Build detailed stats
        result = {
            "service_type": service_type,
            "current_requests": stats["current_requests"],
            "total_requests": stats["total_requests"],
            "rejected_requests": stats["rejected_requests"],
            "max_concurrent_reached": stats["max_concurrent_reached"],
            "success_rate": (stats["total_requests"] - stats["rejected_requests"]) / max(stats["total_requests"], 1) * 100,
            "rejection_rate": stats["rejected_requests"] / max(stats["total_requests"], 1) * 100,
            "status": "healthy" if stats["rejection_rate"] < 5 else "warning" if stats["rejection_rate"] < 15 else "critical"
        }
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get stats for {service_type}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get statistics for {service_type}")

@router.post("/stats/reset", summary="Reset concurrent stats")
async def reset_concurrent_stats(admin_user=Depends(get_current_admin)) -> Dict[str, str]:
    """
    Reset concurrent stats for all services
    Only admin can execute this operation
    """
    try:
        ConcurrentLimitMiddleware.reset_stats()
        logger.info(f"Concurrent statistics reset by admin: {admin_user.get('email', 'unknown')}")
        
        return {
            "message": "All concurrent statistics have been reset successfully",
            "reset_by": admin_user.get("email", "unknown"),
            "services_reset": ["admin", "detection", "proxy"]
        }
        
    except Exception as e:
        logger.error(f"Failed to reset concurrent stats: {e}")
        raise HTTPException(status_code=500, detail="Failed to reset concurrent statistics")

@router.post("/stats/{service_type}/reset", summary="Reset concurrent stats for specified service")
async def reset_service_concurrent_stats(
    service_type: str,
    admin_user=Depends(get_current_admin)
) -> Dict[str, str]:
    """
    Reset concurrent stats for specified service
    
    Args:
        service_type: Service type (admin/detection/proxy)
    """
    try:
        if service_type not in ["admin", "detection", "proxy"]:
            raise HTTPException(status_code=400, detail="Invalid service type. Must be one of: admin, detection, proxy")
        
        ConcurrentLimitMiddleware.reset_stats(service_type)
        logger.info(f"Concurrent statistics reset for {service_type} by admin: {admin_user.get('email', 'unknown')}")
        
        return {
            "message": f"Concurrent statistics for {service_type} service have been reset successfully",
            "reset_by": admin_user.get("email", "unknown"),
            "service": service_type
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to reset stats for {service_type}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to reset statistics for {service_type}")

@router.get("/health", summary="Concurrent health check")
async def concurrent_health_check() -> Dict[str, Any]:
    """
    Check concurrent health status for all services
    No admin permission, used for monitoring
    """
    try:
        all_stats = ConcurrentLimitMiddleware.get_all_stats()
        
        health_status = {
            "overall_status": "healthy",
            "services": {},
            "issues": []
        }
        
        for service_type, stats in all_stats.items():
            rejection_rate = stats["rejected_requests"] / max(stats["total_requests"], 1) * 100
            
            if rejection_rate >= 15:
                status = "critical"
                health_status["overall_status"] = "critical"
                health_status["issues"].append(f"{service_type} service has high rejection rate: {rejection_rate:.1f}%")
            elif rejection_rate >= 5:
                status = "warning"
                if health_status["overall_status"] == "healthy":
                    health_status["overall_status"] = "warning"
                health_status["issues"].append(f"{service_type} service has elevated rejection rate: {rejection_rate:.1f}%")
            else:
                status = "healthy"
            
            health_status["services"][service_type] = {
                "status": status,
                "current_requests": stats["current_requests"],
                "rejection_rate": rejection_rate,
                "max_concurrent_reached": stats["max_concurrent_reached"]
            }
        
        return health_status
        
    except Exception as e:
        logger.error(f"Failed to check concurrent health: {e}")
        return {
            "overall_status": "error",
            "services": {},
            "issues": [f"Failed to retrieve health status: {str(e)}"]
        }