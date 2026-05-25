import asyncio
from datetime import datetime, timedelta
from utils.auth_cache import auth_cache
from services.rate_limiter import rate_limiter
from services.keyword_cache import keyword_cache
from utils.logger import setup_logger

logger = setup_logger()

class CacheCleaner:
    """Cache cleaner service"""
    
    def __init__(self):
        self._cleanup_task = None
        self._running = False
    
    async def start(self):
        """Start cache cleaner service"""
        if self._running:
            return
        
        self._running = True
        self._cleanup_task = asyncio.create_task(self._cleanup_loop())
        logger.info("Cache cleaner service started")
    
    async def stop(self):
        """Stop cache cleaner service"""
        self._running = False
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
        logger.info("Cache cleaner service stopped")
    
    async def _cleanup_loop(self):
        """Cleanup loop"""
        while self._running:
            try:
                # Clean expired auth cache
                auth_cache.clear_expired()
                
                # Clean expired rate limit records (keep recent 2 minutes records)
                current_time = asyncio.get_event_loop().time()
                cutoff_time = current_time - 120  # 2分钟前
                
                # PostgreSQL rate limiter doesn't need manual cleanup of user requests
                # as it uses database storage with automatic cleanup via SQL queries
                
                # Record cache statistics
                auth_cache_size = auth_cache.size()
                rate_limit_users = len(rate_limiter._local_cache)
                keyword_cache_info = keyword_cache.get_cache_info()
                
                if auth_cache_size > 0 or rate_limit_users > 0 or keyword_cache_info['blacklist_keywords'] > 0:
                    logger.debug(f"Cache stats - Auth: {auth_cache_size}, Rate limit users: {rate_limit_users}, Keywords: B{keyword_cache_info['blacklist_keywords']}/W{keyword_cache_info['whitelist_keywords']}")
                
                # Clean every 60 seconds
                await asyncio.sleep(60)
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"Cache cleanup error: {e}")
                await asyncio.sleep(60)

# Global cache cleaner service instance
cache_cleaner = CacheCleaner()