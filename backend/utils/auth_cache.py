import time
import hashlib
from typing import Dict, Optional, Any
from utils.logger import setup_logger

logger = setup_logger()

class AuthCache:
    """Authentication cache - high-performance memory cache"""
    
    def __init__(self, ttl: int = 300):  # 5 minutes cache
        self._cache: Dict[str, Dict[str, Any]] = {}
        self._ttl = ttl
    
    def _make_key(self, token: str) -> str:
        """Generate cache key"""
        return hashlib.md5(token.encode()).hexdigest()
    
    def get(self, token: str) -> Optional[Dict[str, Any]]:
        """Get cached authentication information"""
        key = self._make_key(token)
        if key in self._cache:
            entry = self._cache[key]
            if time.time() - entry['timestamp'] < self._ttl:
                return entry['data']
            else:
                # Expired, delete
                del self._cache[key]
        return None
    
    def set(self, token: str, auth_data: Dict[str, Any]):
        """Set cache"""
        key = self._make_key(token)
        self._cache[key] = {
            'data': auth_data,
            'timestamp': time.time()
        }
    
    def invalidate(self, token: str):
        """Invalidate cache"""
        key = self._make_key(token)
        if key in self._cache:
            del self._cache[key]
    
    def clear_expired(self):
        """Clear expired cache"""
        current_time = time.time()
        expired_keys = []
        
        for key, entry in self._cache.items():
            if current_time - entry['timestamp'] >= self._ttl:
                expired_keys.append(key)
        
        for key in expired_keys:
            del self._cache[key]
        
        if expired_keys:
            logger.debug(f"Cleared {len(expired_keys)} expired auth cache entries")
    
    def size(self) -> int:
        """Get cache size"""
        return len(self._cache)

# Global authentication cache instance
auth_cache = AuthCache(ttl=300)  # 5 minutes cache