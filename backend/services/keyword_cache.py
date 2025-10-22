import time
import asyncio
from typing import List, Tuple, Optional, Dict, Set
from sqlalchemy.orm import Session
from database.models import Blacklist, Whitelist
from database.connection import get_db_session
from utils.logger import setup_logger

logger = setup_logger()

class KeywordCache:
    """High-performance keyword cache service"""
    
    def __init__(self, cache_ttl: int = 300):  # 5 minutes cache
        # Multi-tenant cache structure:
        # Blacklist: {tenant_id: {list_name: {keyword1, keyword2, ...}}}
        # Whitelist: {tenant_id: {list_name: {keyword1, keyword2, ...}}}
        self._blacklist_cache: Dict[str, Dict[str, Set[str]]] = {}
        self._whitelist_cache: Dict[str, Dict[str, Set[str]]] = {}
        self._cache_timestamp = 0
        self._cache_ttl = cache_ttl
        self._lock = asyncio.Lock()
        
    async def check_blacklist(self, content: str, tenant_id: Optional[str]) -> Tuple[bool, Optional[str], List[str]]:
        """Check blacklist (memory cache version)"""
        await self._ensure_cache_fresh()
        
        if not tenant_id:
            return False, None, []

        content_lower = content.lower()
        
        user_blacklists = self._blacklist_cache.get(str(tenant_id), {})
        for list_name, keywords in user_blacklists.items():
            matched_keywords = []
            
            for keyword in keywords:
                if keyword in content_lower:
                    matched_keywords.append(keyword)
            
            if matched_keywords:
                logger.info(f"Blacklist hit: {list_name}, keywords: {matched_keywords}")
                return True, list_name, matched_keywords
        
        return False, None, []
    
    async def check_whitelist(self, content: str, tenant_id: Optional[str]) -> Tuple[bool, Optional[str], List[str]]:
        """Check whitelist (memory cache version)"""
        await self._ensure_cache_fresh()
        
        if not tenant_id:
            return False, None, []

        content_lower = content.lower()
        
        user_whitelists = self._whitelist_cache.get(str(tenant_id), {})
        for list_name, keywords in user_whitelists.items():
            matched_keywords = []
            
            for keyword in keywords:
                if keyword in content_lower:
                    matched_keywords.append(keyword)
            
            if matched_keywords:
                logger.info(f"Whitelist hit: {list_name}, keywords: {matched_keywords}")
                return True, list_name, matched_keywords
        
        return False, None, []
    
    async def _ensure_cache_fresh(self):
        """Ensure cache is fresh"""
        current_time = time.time()
        
        if current_time - self._cache_timestamp > self._cache_ttl:
            async with self._lock:
                # Double check lock
                if current_time - self._cache_timestamp > self._cache_ttl:
                    await self._refresh_cache()
    
    async def _refresh_cache(self):
        """Refresh cache"""
        try:
            db = get_db_session()
            try:
                # Load blacklist (grouped by tenant)
                blacklists = db.query(Blacklist).filter_by(is_active=True).all()
                new_blacklist_cache: Dict[str, Dict[str, Set[str]]] = {}
                for blacklist in blacklists:
                    tenant_id_str = str(blacklist.tenant_id)
                    keywords = blacklist.keywords if isinstance(blacklist.keywords, list) else []
                    keyword_set = {keyword.lower() for keyword in keywords if keyword}
                    if not keyword_set:
                        continue
                    if tenant_id_str not in new_blacklist_cache:
                        new_blacklist_cache[tenant_id_str] = {}
                    new_blacklist_cache[tenant_id_str][blacklist.name] = keyword_set

                # Load whitelist (grouped by tenant)
                whitelists = db.query(Whitelist).filter_by(is_active=True).all()
                new_whitelist_cache: Dict[str, Dict[str, Set[str]]] = {}
                for whitelist in whitelists:
                    tenant_id_str = str(whitelist.tenant_id)
                    keywords = whitelist.keywords if isinstance(whitelist.keywords, list) else []
                    keyword_set = {keyword.lower() for keyword in keywords if keyword}
                    if not keyword_set:
                        continue
                    if tenant_id_str not in new_whitelist_cache:
                        new_whitelist_cache[tenant_id_str] = {}
                    new_whitelist_cache[tenant_id_str][whitelist.name] = keyword_set

                # Atomic update cache
                self._blacklist_cache = new_blacklist_cache
                self._whitelist_cache = new_whitelist_cache
                self._cache_timestamp = time.time()
                
                blacklist_list_count = sum(len(lists) for lists in new_blacklist_cache.values())
                whitelist_list_count = sum(len(lists) for lists in new_whitelist_cache.values())
                blacklist_keyword_count = sum(
                    sum(len(keywords) for keywords in lists.values()) for lists in new_blacklist_cache.values()
                )
                whitelist_keyword_count = sum(
                    sum(len(keywords) for keywords in lists.values()) for lists in new_whitelist_cache.values()
                )
                logger.debug(
                    f"Keyword cache refreshed - Users: BL {len(new_blacklist_cache)}, WL {len(new_whitelist_cache)}; "
                    f"Lists: BL {blacklist_list_count}, WL {whitelist_list_count}; "
                    f"Keywords: BL {blacklist_keyword_count}, WL {whitelist_keyword_count}"
                )
                
            finally:
                db.close()
                
        except Exception as e:
            logger.error(f"Failed to refresh keyword cache: {e}")
    
    async def invalidate_cache(self):
        """Immediately invalidate cache"""
        async with self._lock:
            self._cache_timestamp = 0
            logger.info("Keyword cache invalidated")
    
    def get_cache_info(self) -> dict:
        """Get cache statistics"""
        blacklist_list_count = sum(len(lists) for lists in self._blacklist_cache.values())
        whitelist_list_count = sum(len(lists) for lists in self._whitelist_cache.values())
        blacklist_keyword_count = sum(
            sum(len(keywords) for keywords in lists.values()) for lists in self._blacklist_cache.values()
        )
        whitelist_keyword_count = sum(
            sum(len(keywords) for keywords in lists.values()) for lists in self._whitelist_cache.values()
        )

        return {
            "users_with_blacklists": len(self._blacklist_cache),
            "users_with_whitelists": len(self._whitelist_cache),
            "blacklist_lists": blacklist_list_count,
            "blacklist_keywords": blacklist_keyword_count,
            "whitelist_lists": whitelist_list_count,
            "whitelist_keywords": whitelist_keyword_count,
            "last_refresh": self._cache_timestamp,
            "cache_age_seconds": time.time() - self._cache_timestamp if self._cache_timestamp > 0 else 0
        }

# Global keyword cache instance
keyword_cache = KeywordCache(cache_ttl=300)  # 5 minutes cache