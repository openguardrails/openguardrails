import os
import json
import asyncio
import aiofiles
from datetime import datetime, timezone
from typing import Dict, Any, Optional
from pathlib import Path
from utils.logger import setup_logger

logger = setup_logger()

class AsyncDetectionLogger:
    """Async detection result logger"""
    
    def __init__(self, log_dir: Optional[str] = None):
        if log_dir is None:
            from config import settings
            log_dir = settings.detection_log_dir
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self._queue = asyncio.Queue()
        self._writer_task: Optional[asyncio.Task] = None
        self._running = False
    
    async def start(self):
        """Start async write task"""
        if not self._running:
            self._running = True
            self._writer_task = asyncio.create_task(self._writer_loop())
            logger.info("AsyncDetectionLogger started")
        else:
            logger.debug("AsyncDetectionLogger already running, skipping start")
    
    async def stop(self):
        """Stop async write task"""
        if self._running:
            self._running = False
            # Send stop signal
            await self._queue.put(None)
            if self._writer_task:
                await self._writer_task
            logger.info("AsyncDetectionLogger stopped")
    
    async def log_detection(self, detection_data: Dict[str, Any]):
        """Log detection result to file"""
        if not self._running:
            await self.start()
        
        # Clean NUL characters in data
        from utils.validators import clean_detection_data
        cleaned_data = clean_detection_data(detection_data.copy())
        
        # Add timestamp (with timezone info)
        cleaned_data['logged_at'] = datetime.now(timezone.utc).isoformat()
        
        # Add to queue for batch processing by writer loop
        await self._queue.put(cleaned_data)
        logger.debug(f"Queued detection for logging: {cleaned_data['request_id']}")
    
    async def _writer_loop(self):
        """Async write loop (batch optimized version)"""
        current_date = None
        current_file = None
        batch = []
        batch_size = 1  # Immediate write mode (for debugging)
        last_flush_time = asyncio.get_event_loop().time()
        flush_interval = 0.1  # 0.1 seconds force flush (immediate write)
        
        try:
            while self._running:
                try:
                    # Collect batch data
                    current_time = asyncio.get_event_loop().time()
                    try:
                        data = await asyncio.wait_for(self._queue.get(), timeout=0.5)
                        
                        # Stop signal
                        if data is None:
                            break
                        
                        batch.append(data)
                        
                        # Check if need to write
                        should_flush = (
                            len(batch) >= batch_size or 
                            (current_time - last_flush_time) >= flush_interval
                        )
                        
                        if should_flush and batch:
                            await self._flush_batch(batch, current_date, current_file)
                            batch.clear()
                            last_flush_time = current_time
                            
                            # Update file handle
                            today = datetime.now().strftime('%Y%m%d')
                            if current_date != today:
                                if current_file:
                                    await current_file.close()
                                
                                current_date = today
                                log_file_path = self.log_dir / f"detection_{today}.jsonl"
                                current_file = await aiofiles.open(log_file_path, 'a', encoding='utf-8')
                                logger.debug(f"Opened new log file: {log_file_path}")
                        
                    except asyncio.TimeoutError:
                        # Timeout, check if need to flush accumulated data
                        if batch and (current_time - last_flush_time) >= flush_interval:
                            await self._flush_batch(batch, current_date, current_file)
                            batch.clear()
                            last_flush_time = current_time
                        continue
                        
                except Exception as e:
                    logger.error(f"Error in async logger writer loop: {e}")
            
            # Process remaining batch data
            if batch:
                await self._flush_batch(batch, current_date, current_file)
                
        except Exception as e:
            logger.error(f"Fatal error in async logger writer loop: {e}")
        finally:
            if current_file:
                await current_file.close()
            logger.info("Async logger writer loop stopped")
    
    async def _flush_batch(self, batch: list, current_date: str, current_file):
        """Flush batch data to file"""
        if not batch or not current_file:
            return
            
        try:
            # Batch write
            lines = []
            for data in batch:
                json_line = json.dumps(data, ensure_ascii=False) + '\n'
                lines.append(json_line)
            
            await current_file.write(''.join(lines))
            await current_file.flush()
            
            logger.debug(f"Flushed {len(batch)} log entries")
            
        except Exception as e:
            logger.error(f"Error flushing batch: {e}")
    
    def get_log_files(self, date_range: Optional[tuple] = None) -> list:
        """Get log file list"""
        pattern = "detection_*.jsonl"
        files = list(self.log_dir.glob(pattern))
        files.sort(key=lambda x: x.name)
        
        if date_range:
            start_date, end_date = date_range
            filtered_files = []
            for file in files:
                try:
                    file_date = file.stem.split('_')[1]
                    if start_date <= file_date <= end_date:
                        filtered_files.append(file)
                except (IndexError, ValueError):
                    continue
            return filtered_files
        
        return files

# Global instance
async_detection_logger = AsyncDetectionLogger()