import json
import asyncio
import aiofiles
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import List, Dict, Any, Optional
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from database.connection import get_db_session
from database.models import DetectionResult
from services.async_logger import async_detection_logger
from utils.logger import setup_logger

logger = setup_logger()

class DataSyncService:
    """Data sync service - sync data from log files to PostgreSQL database"""
    
    def __init__(self, sync_interval: int = 60):
        """
        Initialize data sync service
        
        Args:
            sync_interval: sync interval (seconds), default 60 seconds
        """
        self.sync_interval = sync_interval
        self._running = False
        self._sync_task: Optional[asyncio.Task] = None
        self._processed_files = set()  # Record processed files to avoid duplicate processing
    
    async def start(self):
        """Start data sync service"""
        if not self._running:
            self._running = True
            self._sync_task = asyncio.create_task(self._sync_loop())
            logger.info("DataSyncService started")
        else:
            logger.debug("DataSyncService already running, skipping start")
    
    async def stop(self):
        """Stop data sync service"""
        if self._running:
            self._running = False
            if self._sync_task:
                self._sync_task.cancel()
                try:
                    await self._sync_task
                except asyncio.CancelledError:
                    pass
            logger.info("DataSyncService stopped")
    
    async def _sync_loop(self):
        """Sync loop"""
        while self._running:
            try:
                await self.sync_data()
                await asyncio.sleep(self.sync_interval)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Error in data sync loop: {e}")
                # Wait longer before retrying when an error occurs
                await asyncio.sleep(self.sync_interval * 3)
    
    async def sync_data(self):
        """Sync data to database"""
        try:
            # Get log files to process
            log_files = await self._get_pending_log_files()
            
            if not log_files:
                logger.debug("No pending log files to process")
                return
            
            logger.info(f"Found {len(log_files)} log files to process")
            
            # Process log files one by one
            for log_file in log_files:
                await self._process_log_file(log_file)
                
        except Exception as e:
            logger.error(f"Error in sync_data: {e}")
    
    async def _get_pending_log_files(self) -> List[Path]:
        """Get pending log files"""
        # Get log files from the last 3 days (to avoid processing old files)
        end_date = datetime.now().date()
        start_date = end_date - timedelta(days=2)
        
        date_range = (
            start_date.strftime('%Y%m%d'),
            end_date.strftime('%Y%m%d')
        )
        
        all_files = async_detection_logger.get_log_files(date_range)
        
        # Filter out unprocessed files
        pending_files = []
        for file_path in all_files:
            # Check if the file has been fully processed
            if not await self._is_file_fully_processed(file_path):
                pending_files.append(file_path)
        
        # Sort by file name to ensure processing in chronological order
        pending_files.sort(key=lambda x: x.name)
        
        return pending_files
    
    async def _is_file_fully_processed(self, file_path: Path) -> bool:
        """Check if the file has been fully processed"""
        try:
            # Check file modification time, if it's a recent file from today, it might still be being written
            stat = file_path.stat()
            last_modified = datetime.fromtimestamp(stat.st_mtime)
            
            # If the file was modified in the last 5 minutes, it might still be being written
            if datetime.now() - last_modified < timedelta(minutes=5):
                return False
                
            # Check if the file is in the processed list
            return str(file_path) in self._processed_files
            
        except FileNotFoundError:
            return True  # File not found, considered processed
    
    async def _process_log_file(self, file_path: Path):
        """Process a single log file"""
        logger.info(f"Processing log file: {file_path}")
        
        try:
            processed_count = 0
            error_count = 0
            
            async with aiofiles.open(file_path, 'r', encoding='utf-8') as f:
                async for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    
                    try:
                        # Parse JSON line
                        detection_data = json.loads(line)
                        
                        # Clean NUL characters in data
                        from utils.validators import clean_detection_data
                        cleaned_data = clean_detection_data(detection_data)
                        
                        # Sync to database
                        await self._sync_detection_to_db(cleaned_data)
                        processed_count += 1
                        
                        # Batch commit, improve performance
                        if processed_count % 100 == 0:
                            logger.debug(f"Processed {processed_count} records from {file_path.name}")
                            
                    except json.JSONDecodeError as e:
                        logger.error(f"Invalid JSON in {file_path}: {line[:100]}...")
                        error_count += 1
                    except Exception as e:
                        logger.error(f"Error processing record in {file_path}: {e}")
                        error_count += 1
            
            # Mark file as processed
            self._processed_files.add(str(file_path))
            
            logger.info(f"Completed processing {file_path.name}: {processed_count} processed, {error_count} errors")
            
        except Exception as e:
            logger.error(f"Error processing log file {file_path}: {e}")
    
    async def _sync_detection_to_db(self, detection_data: Dict[str, Any]):
        """Sync single detection record to database"""
        db: Session = get_db_session()
        
        try:
            # Check if the record already exists
            existing = db.query(DetectionResult).filter_by(
                request_id=detection_data.get('request_id')
            ).first()
            
            if existing:
                # Record already exists, skip
                return
            
            # Parse time
            created_at = None
            if detection_data.get('created_at'):
                try:
                    # Process multiple time formats
                    time_str = detection_data['created_at']
                    if time_str.endswith('Z'):
                        time_str = time_str.replace('Z', '+00:00')
                    elif not time_str.endswith(('+00:00', '+08:00')) and 'T' in time_str:
                        # If there is no timezone information, assume local time in China (UTC+8)
                        time_str = time_str + '+08:00'
                    created_at = datetime.fromisoformat(time_str)
                except ValueError:
                    created_at = datetime.now(timezone.utc)
            
            # Create detection result record
            tenant_id = detection_data.get('tenant_id')
            if tenant_id is not None:
                import uuid
                try:
                    # If it's a string number, convert to UUID
                    if isinstance(tenant_id, str) and tenant_id.isdigit():
                        # Simple numeric ID cannot be directly converted to UUID, need to find the corresponding actual UUID
                        # Here set to None to avoid error
                        tenant_id = None
                    elif isinstance(tenant_id, str):
                        # Try to parse as UUID
                        tenant_id = uuid.UUID(tenant_id)
                    elif isinstance(tenant_id, int):
                        # Numeric ID cannot be directly converted to UUID
                        tenant_id = None
                except (ValueError, TypeError):
                    tenant_id = None
            
            detection_result = DetectionResult(
                    request_id=detection_data.get('request_id'),
                    tenant_id=tenant_id,
                    content=detection_data.get('content'),
                    suggest_action=detection_data.get('suggest_action'),
                    suggest_answer=detection_data.get('suggest_answer'),
                    hit_keywords=detection_data.get('hit_keywords'),
                    model_response=detection_data.get('model_response'),
                    ip_address=detection_data.get('ip_address'),
                    user_agent=detection_data.get('user_agent'),
                    security_risk_level=detection_data.get('security_risk_level', 'no_risk'),
                    security_categories=detection_data.get('security_categories', []),
                    compliance_risk_level=detection_data.get('compliance_risk_level', 'no_risk'),
                    compliance_categories=detection_data.get('compliance_categories', []),
                    has_image=detection_data.get('has_image', False),
                    image_count=detection_data.get('image_count', 0),
                    image_paths=detection_data.get('image_paths', []),
                    created_at=created_at or datetime.now(timezone.utc)
                )
            
            db.add(detection_result)
            db.commit()
            
        except IntegrityError as e:
            # Duplicate record, rollback and skip
            db.rollback()
            logger.debug(f"Duplicate record skipped: {detection_data.get('request_id')}")
        except Exception as e:
            db.rollback()
            logger.error(f"Error syncing detection to DB: {e}")
            raise
        finally:
            db.close()
    
    async def force_sync(self, date_range: Optional[tuple] = None):
        """Force sync data for specified date range"""
        logger.info("Starting force sync...")
        
        try:
            # Clear processed file records, force re-processing
            if date_range:
                # Only clear records for the specified date range
                for file_key in list(self._processed_files):
                    if any(date in file_key for date in [date_range[0], date_range[1]]):
                        self._processed_files.discard(file_key)
            else:
                # Clear all records
                self._processed_files.clear()
            
            # Get files and process
            if date_range:
                log_files = async_detection_logger.get_log_files(date_range)
            else:
                log_files = async_detection_logger.get_log_files()
            
            for log_file in log_files:
                await self._process_log_file(log_file)
                
            logger.info("Force sync completed")
            
        except Exception as e:
            logger.error(f"Error in force sync: {e}")
            raise

# Global instance
data_sync_service = DataSyncService()