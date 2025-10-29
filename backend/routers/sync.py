from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from datetime import datetime, date
from services.log_to_db_service import log_to_db_service
from services.async_logger import async_detection_logger
from utils.logger import setup_logger
from config import settings

logger = setup_logger()
router = APIRouter(tags=["Data Sync"])

@router.post("/sync/force")
async def force_sync_data(
    start_date: Optional[str] = Query(None, description="Start date (YYYYMMDD)"),
    end_date: Optional[str] = Query(None, description="End date (YYYYMMDD)")
):
    """
    Force sync log data to database

    Args:
        start_date: Start date, format YYYYMMDD
        end_date: End date, format YYYYMMDD
    """
    # Check if log to DB service is enabled
    if not settings.store_detection_results:
        raise HTTPException(
            status_code=400,
            detail="Log to DB service is disabled. Set STORE_DETECTION_RESULTS=true to enable."
        )

    try:
        date_range = None
        if start_date and end_date:
            # Validate date format
            try:
                datetime.strptime(start_date, '%Y%m%d')
                datetime.strptime(end_date, '%Y%m%d')
                date_range = (start_date, end_date)
            except ValueError:
                raise HTTPException(status_code=400, detail="Date format error, please use YYYYMMDD format")

        # Execute force sync
        await log_to_db_service.force_sync(date_range)

        return {
            "status": "success",
            "message": "Data sync completed",
            "date_range": date_range,
            "timestamp": datetime.now().isoformat()
        }

    except Exception as e:
        logger.error(f"Force sync failed: {e}")
        raise HTTPException(status_code=500, detail=f"Sync failed: {str(e)}")

@router.get("/sync/status")
async def get_sync_status():
    """
    Get data sync service status
    """
    try:
        from pathlib import Path

        # Get log file information
        detection_log_dir = Path(settings.detection_log_dir)
        log_files = sorted(detection_log_dir.glob("detection_*.jsonl")) if detection_log_dir.exists() else []

        # Count log file information
        file_info = []
        for log_file in log_files[-5:]:  # Only show the last 5 files
            try:
                stat = log_file.stat()
                processed_lines = log_to_db_service.processed_files.get(log_file.name, 0)
                file_info.append({
                    "filename": log_file.name,
                    "size_bytes": stat.st_size,
                    "processed_lines": processed_lines,
                    "last_modified": datetime.fromtimestamp(stat.st_mtime).isoformat()
                })
            except:
                continue

        return {
            "sync_service_running": log_to_db_service.running,
            "sync_service_enabled": settings.store_detection_results,
            "async_logger_running": async_detection_logger._running,
            "total_files_processed": len(log_to_db_service.processed_files),
            "total_lines_processed": sum(log_to_db_service.processed_files.values()),
            "recent_log_files": file_info,
            "timestamp": datetime.now().isoformat()
        }

    except Exception as e:
        logger.error(f"Get sync status failed: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get status: {str(e)}")

@router.post("/sync/restart")
async def restart_sync_service():
    """
    Restart data sync service
    """
    # Check if log to DB service is enabled
    if not settings.store_detection_results:
        raise HTTPException(
            status_code=400,
            detail="Log to DB service is disabled. Set STORE_DETECTION_RESULTS=true to enable."
        )

    try:
        # Stop services
        await log_to_db_service.stop()
        await async_detection_logger.stop()

        # Start services
        await async_detection_logger.start()
        await log_to_db_service.start()

        return {
            "status": "success",
            "message": "Data sync service restarted",
            "timestamp": datetime.now().isoformat()
        }

    except Exception as e:
        logger.error(f"Restart sync service failed: {e}")
        raise HTTPException(status_code=500, detail=f"Restart failed: {str(e)}")