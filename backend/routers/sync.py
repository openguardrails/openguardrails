from fastapi import APIRouter, HTTPException, Query
from typing import Optional
from datetime import datetime, date
from services.data_sync_service import data_sync_service
from services.async_logger import async_detection_logger
from utils.logger import setup_logger

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
        await data_sync_service.force_sync(date_range)
        
        return {
            "status": "success",
            "message": "Data sync completed",
            "date_range": date_range,
            "timestamp": datetime.now().isoformat()
        }
        
    except Exception as e:
        logger.error(f"Force sync failed: {e}")
        raise HTTPException(status_code=500, detail=f"同步失败: {str(e)}")

@router.get("/sync/status")
async def get_sync_status():
    """
    Get data sync service status
    """
    try:
        # Get log file information
        log_files = async_detection_logger.get_log_files()
        
        # Count log file information
        file_info = []
        for log_file in log_files[-5:]:  # Only show the last 5 files
            try:
                stat = log_file.stat()
                file_info.append({
                    "filename": log_file.name,
                    "size_bytes": stat.st_size,
                    "last_modified": datetime.fromtimestamp(stat.st_mtime).isoformat()
                })
            except:
                continue
        
        return {
            "sync_service_running": data_sync_service._running,
            "async_logger_running": async_detection_logger._running,
            "recent_log_files": file_info,
            "timestamp": datetime.now().isoformat()
        }
        
    except Exception as e:
        logger.error(f"Get sync status failed: {e}")
        raise HTTPException(status_code=500, detail=f"获取状态失败: {str(e)}")

@router.post("/sync/restart")
async def restart_sync_service():
    """
    Restart data sync service
    """
    try:
        # Stop service
        await data_sync_service.stop()
        await async_detection_logger.stop()
        
        # Start service
        await async_detection_logger.start()
        await data_sync_service.start()
        
        return {
            "status": "success",
            "message": "Data sync service restarted",
            "timestamp": datetime.now().isoformat()
        }
        
    except Exception as e:
        logger.error(f"Restart sync service failed: {e}")
        raise HTTPException(status_code=500, detail=f"Restart failed: {str(e)}")