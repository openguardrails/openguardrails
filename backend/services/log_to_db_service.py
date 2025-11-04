import asyncio
import json
import uuid
import pickle
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Set, Dict
from sqlalchemy.orm import Session
from database.models import DetectionResult
from database.connection import get_admin_db_session
from utils.logger import setup_logger

logger = setup_logger()

class LogToDbService:
    """Log to DB service - import detection log files to PostgreSQL database"""

    def __init__(self):
        self.running = False
        self.task = None
        self.processed_files: Dict[str, int] = {}  # filename -> processed line count
        self._state_file = None  # Will be initialized when starting
    
    async def start(self):
        """Start log to DB service"""
        if self.running:
            return
        
        # Initialize state file path
        from config import settings
        self._state_file = Path(settings.data_dir) / "log_to_db_service_state.pkl"
        
        # Load processed files state
        await self._load_processed_files_state()
            
        self.running = True
        self.task = asyncio.create_task(self._process_logs_loop())
        logger.info(f"Log to DB service started (loaded {len(self.processed_files)} processed files from state)")
    
    async def stop(self):
        """Stop log to DB service"""
        if not self.running:
            return
        
        # Save processed files state
        await self._save_processed_files_state()
            
        self.running = False
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except asyncio.CancelledError:
                pass
        logger.info("Log to DB service stopped")
    
    async def _process_logs_loop(self):
        """Process logs file loop"""
        while self.running:
            try:
                await self._process_log_files()
                await asyncio.sleep(5)  # Check new logs every 5 seconds (greatly improve sync frequency)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Log processing error: {e}")
                await asyncio.sleep(60)  # Wait longer when error occurs
    
    async def _process_log_files(self):
        """Process all unprocessed log files (with incremental processing)"""
        from config import settings

        detection_log_dir = Path(settings.detection_log_dir)
        if not detection_log_dir.exists():
            return

        # Find all detection log files
        log_files = list(detection_log_dir.glob("detection_*.jsonl"))

        for log_file in log_files:
            # Get total lines in file
            try:
                total_lines = self._count_lines(log_file)
            except Exception as e:
                logger.error(f"Failed to count lines in {log_file.name}: {e}")
                continue

            # Get processed line count
            processed_lines = self.processed_files.get(log_file.name, 0)

            # Check if there are new lines to process
            if total_lines > processed_lines:
                new_lines = total_lines - processed_lines
                logger.info(f"Processing {new_lines} new lines in {log_file.name} (processed: {processed_lines}, total: {total_lines})")

                # Process new lines only
                new_processed = await self._process_single_log_file(log_file, start_line=processed_lines)

                # Update processed line count
                self.processed_files[log_file.name] = processed_lines + new_processed

                # Save state after each file is processed
                await self._save_processed_files_state()
            else:
                # No new lines
                if log_file.name not in self.processed_files:
                    # First time seeing this file, mark as processed
                    self.processed_files[log_file.name] = total_lines
                    await self._save_processed_files_state()
    
    def _count_lines(self, log_file: Path) -> int:
        """Count total lines in file (non-empty lines only)"""
        count = 0
        with open(log_file, 'r', encoding='utf-8') as f:
            for line in f:
                if line.strip():
                    count += 1
        return count

    async def _process_single_log_file(self, log_file: Path, start_line: int = 0) -> int:
        """Process single log file from start_line (incremental)

        Args:
            log_file: Path to log file
            start_line: Line number to start from (0-indexed, counting non-empty lines only)

        Returns:
            Number of lines successfully processed
        """
        processed_count = 0
        try:
            db = get_admin_db_session()
            try:
                with open(log_file, 'r', encoding='utf-8') as f:
                    current_line = 0
                    for line_num, line in enumerate(f, 1):
                        line = line.strip()
                        if not line:
                            continue

                        # Skip already processed lines
                        if current_line < start_line:
                            current_line += 1
                            continue

                        try:
                            log_data = json.loads(line)

                            # Clean NUL characters in data
                            from utils.validators import clean_detection_data
                            cleaned_data = clean_detection_data(log_data)

                            # Try to save and commit individually to handle duplicates gracefully
                            if await self._save_log_to_db(db, cleaned_data):
                                processed_count += 1
                        except json.JSONDecodeError as e:
                            logger.warning(f"Invalid JSON in {log_file}:{line_num}: {e}")
                        except Exception as e:
                            logger.error(f"Error processing log entry {log_file}:{line_num}: {e}")

                        current_line += 1

                logger.info(f"Processed {processed_count} new lines from {log_file.name}")

            finally:
                db.close()

        except Exception as e:
            logger.error(f"Error processing log file {log_file}: {e}")

        return processed_count
    
    async def _save_log_to_db(self, db: Session, log_data: dict) -> bool:
        """Save log data to database
        
        Returns:
            True if successfully saved, False if skipped (duplicate or error)
        """
        from sqlalchemy.exc import IntegrityError
        
        try:
            # Check if already exists (avoid duplicate import)
            existing = db.query(DetectionResult).filter_by(
                request_id=log_data.get('request_id')
            ).first()
            
            if existing:
                logger.debug(f"Skipping duplicate record: {log_data.get('request_id')}")
                return False  # Already exists, skip
            
            # Parse tenant ID
            tenant_id = log_data.get('tenant_id')  # Field name kept as tenant_id for backward compatibility
            if tenant_id and isinstance(tenant_id, str):
                try:
                    tenant_id = uuid.UUID(tenant_id)
                except ValueError:
                    tenant_id = None
            
            # Parse created time
            created_at = None
            if log_data.get('created_at'):
                try:
                    # Process multiple time formats
                    time_str = log_data['created_at']
                    if time_str.endswith('Z'):
                        time_str = time_str.replace('Z', '+00:00')
                    elif not time_str.endswith(('+00:00', '+08:00')) and 'T' in time_str:
                        # If there is no timezone information, assume local time in China (UTC+8)
                        time_str = time_str + '+08:00'
                    created_at = datetime.fromisoformat(time_str)
                except ValueError:
                    created_at = datetime.now(timezone.utc)
            else:
                created_at = datetime.now(timezone.utc)
            
            # Create detection result record
            detection_result = DetectionResult(
                request_id=log_data.get('request_id'),
                tenant_id=tenant_id,
                content=log_data.get('content'),
                suggest_action=log_data.get('suggest_action'),
                suggest_answer=log_data.get('suggest_answer'),
                model_response=log_data.get('model_response'),
                ip_address=log_data.get('ip_address'),
                user_agent=log_data.get('user_agent'),
                security_risk_level=log_data.get('security_risk_level', 'no_risk'),
                security_categories=log_data.get('security_categories', []),
                compliance_risk_level=log_data.get('compliance_risk_level', 'no_risk'),
                compliance_categories=log_data.get('compliance_categories', []),
                data_risk_level=log_data.get('data_risk_level', 'no_risk'),
                data_categories=log_data.get('data_categories', []),
                has_image=log_data.get('has_image', False),
                image_count=log_data.get('image_count', 0),
                image_paths=log_data.get('image_paths', []),
                created_at=created_at
            )
            
            db.add(detection_result)
            db.commit()  # Commit each record individually to handle duplicates
            return True
            
        except IntegrityError as e:
            # Handle duplicate key violations gracefully
            db.rollback()
            logger.debug(f"Duplicate record skipped (IntegrityError): {log_data.get('request_id')}")
            return False
        except Exception as e:
            db.rollback()
            logger.error(f"Error saving log data to DB: {e}")
            return False
    
    async def _load_processed_files_state(self):
        """Load processed files state from file"""
        try:
            if self._state_file and self._state_file.exists():
                with open(self._state_file, 'rb') as f:
                    loaded_state = pickle.load(f)
                    # Handle both old format (set) and new format (dict)
                    if isinstance(loaded_state, set):
                        # Old format: convert to dict with 0 processed lines
                        # This will force reprocessing with the new incremental logic
                        self.processed_files = {}
                        logger.info(f"Migrated old state format (set) to new format (dict)")
                    elif isinstance(loaded_state, dict):
                        self.processed_files = loaded_state
                        logger.info(f"Loaded state for {len(self.processed_files)} files from state file")
                    else:
                        logger.warning(f"Unknown state format: {type(loaded_state)}, starting fresh")
                        self.processed_files = {}
            else:
                logger.info("No state file found, starting with empty processed files dict")
        except Exception as e:
            logger.error(f"Error loading processed files state: {e}")
            self.processed_files = {}
    
    async def _save_processed_files_state(self):
        """Save processed files state to file"""
        try:
            if self._state_file:
                # Ensure directory exists
                self._state_file.parent.mkdir(parents=True, exist_ok=True)
                with open(self._state_file, 'wb') as f:
                    pickle.dump(self.processed_files, f)
                total_lines = sum(self.processed_files.values())
                logger.debug(f"Saved state for {len(self.processed_files)} files ({total_lines} total lines processed)")
        except Exception as e:
            logger.error(f"Error saving processed files state: {e}")

    async def force_sync(self, date_range: Optional[tuple] = None):
        """Force sync all log files (for manual triggering)

        Args:
            date_range: Optional tuple of (start_date, end_date) in YYYYMMDD format
                       If not provided, syncs all files
        """
        from config import settings
        from pathlib import Path

        logger.info(f"Starting force sync (date_range: {date_range})...")

        try:
            detection_log_dir = Path(settings.detection_log_dir)
            if not detection_log_dir.exists():
                logger.warning(f"Detection log directory does not exist: {detection_log_dir}")
                return

            # Find all detection log files
            log_files = list(detection_log_dir.glob("detection_*.jsonl"))

            # Filter by date range if provided
            if date_range:
                start_date, end_date = date_range
                filtered_files = []
                for log_file in log_files:
                    # Extract date from filename (detection_YYYYMMDD.jsonl)
                    try:
                        file_date = log_file.stem.split('_')[1]
                        if start_date <= file_date <= end_date:
                            filtered_files.append(log_file)
                    except (IndexError, ValueError):
                        continue
                log_files = filtered_files

            if not log_files:
                logger.info("No log files found to sync")
                return

            logger.info(f"Force syncing {len(log_files)} log files...")

            # Clear processed state for these files to force reprocessing
            for log_file in log_files:
                if log_file.name in self.processed_files:
                    logger.info(f"Clearing processed state for {log_file.name} (was at line {self.processed_files[log_file.name]})")
                    del self.processed_files[log_file.name]

            # Save cleared state
            await self._save_processed_files_state()

            # Process all files
            for log_file in sorted(log_files):
                logger.info(f"Force processing {log_file.name}...")
                new_processed = await self._process_single_log_file(log_file, start_line=0)
                self.processed_files[log_file.name] = new_processed
                await self._save_processed_files_state()

            logger.info("Force sync completed")

        except Exception as e:
            logger.error(f"Error in force sync: {e}")
            raise

# Global instance
log_to_db_service = LogToDbService()