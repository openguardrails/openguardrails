import time
import asyncio
from typing import List, Tuple, Optional, Dict, Set
from sqlalchemy.orm import Session
from database.models import Blacklist, Whitelist, Application
from database.connection import get_db_session
from utils.logger import setup_logger

logger = setup_logger()

class KeywordCache:
    """High-performance keyword cache service (workspace scoped)"""

    def __init__(self, cache_ttl: int = 60):  # 1 minute cache
        # Workspace-level caches: {workspace_id: {list_name: {keyword1, keyword2, ...}}}
        self._blacklist_cache: Dict[str, Dict[str, Set[str]]] = {}
        self._whitelist_cache: Dict[str, Dict[str, Set[str]]] = {}
        # App → workspace mapping: {application_id: workspace_id}
        self._app_workspace_map: Dict[str, str] = {}
        self._cache_timestamp = 0
        self._cache_ttl = cache_ttl
        self._lock = asyncio.Lock()

    def _resolve_workspace_id(self, application_id: Optional[str]) -> Optional[str]:
        """Resolve application_id to workspace_id using cached mapping"""
        if not application_id:
            return None
        return self._app_workspace_map.get(str(application_id))

    async def check_blacklist(self, content: str, tenant_id: Optional[str] = None, application_id: Optional[str] = None) -> Tuple[bool, Optional[str], List[str]]:
        """
        Check blacklist (memory cache version, workspace-level lists)

        Args:
            content: Content to check
            tenant_id: DEPRECATED - kept for backward compatibility
            application_id: Application ID (resolved to workspace_id internally)
        """
        await self._ensure_cache_fresh()

        workspace_id = self._resolve_workspace_id(application_id)
        if not workspace_id:
            return False, None, []

        content_lower = content.lower()

        blacklists = self._blacklist_cache.get(workspace_id, {})
        for list_name, keywords in blacklists.items():
            matched_keywords = []
            for keyword in keywords:
                if keyword in content_lower:
                    matched_keywords.append(keyword)
            if matched_keywords:
                logger.info(f"Blacklist hit: {list_name}, keywords: {matched_keywords}, workspace_id: {workspace_id}, application_id: {application_id}")
                return True, list_name, matched_keywords

        return False, None, []

    async def check_whitelist(self, content: str, tenant_id: Optional[str] = None, application_id: Optional[str] = None) -> Tuple[bool, Optional[str], List[str]]:
        """
        Check whitelist (memory cache version, workspace-level lists)

        Args:
            content: Content to check
            tenant_id: DEPRECATED - kept for backward compatibility
            application_id: Application ID (resolved to workspace_id internally)
        """
        await self._ensure_cache_fresh()

        workspace_id = self._resolve_workspace_id(application_id)
        if not workspace_id:
            return False, None, []

        content_lower = content.lower()

        whitelists = self._whitelist_cache.get(workspace_id, {})
        for list_name, keywords in whitelists.items():
            matched_keywords = []
            for keyword in keywords:
                if keyword in content_lower:
                    matched_keywords.append(keyword)
            if matched_keywords:
                logger.info(f"Whitelist hit: {list_name}, keywords: {matched_keywords}, workspace_id: {workspace_id}, application_id: {application_id}")
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
        """Refresh cache (workspace scoped only)"""
        try:
            db = get_db_session()
            try:
                # Load app → workspace mapping
                new_app_ws_map: Dict[str, str] = {}
                apps = db.query(Application.id, Application.workspace_id).filter(
                    Application.workspace_id.isnot(None)
                ).all()
                for app in apps:
                    new_app_ws_map[str(app.id)] = str(app.workspace_id)

                # Load blacklist (grouped by workspace_id only)
                blacklists = db.query(Blacklist).filter(
                    Blacklist.is_active == True,
                    Blacklist.workspace_id.isnot(None)
                ).all()
                new_blacklist_cache: Dict[str, Dict[str, Set[str]]] = {}
                for blacklist in blacklists:
                    keywords = blacklist.keywords if isinstance(blacklist.keywords, list) else []
                    keyword_set = {keyword.lower() for keyword in keywords if keyword}
                    if not keyword_set:
                        continue

                    ws_id_str = str(blacklist.workspace_id)
                    if ws_id_str not in new_blacklist_cache:
                        new_blacklist_cache[ws_id_str] = {}
                    new_blacklist_cache[ws_id_str][blacklist.name] = keyword_set

                # Load whitelist (grouped by workspace_id only)
                whitelists = db.query(Whitelist).filter(
                    Whitelist.is_active == True,
                    Whitelist.workspace_id.isnot(None)
                ).all()
                new_whitelist_cache: Dict[str, Dict[str, Set[str]]] = {}
                for whitelist in whitelists:
                    keywords = whitelist.keywords if isinstance(whitelist.keywords, list) else []
                    keyword_set = {keyword.lower() for keyword in keywords if keyword}
                    if not keyword_set:
                        continue

                    ws_id_str = str(whitelist.workspace_id)
                    if ws_id_str not in new_whitelist_cache:
                        new_whitelist_cache[ws_id_str] = {}
                    new_whitelist_cache[ws_id_str][whitelist.name] = keyword_set

                # Atomic update all caches
                self._blacklist_cache = new_blacklist_cache
                self._whitelist_cache = new_whitelist_cache
                self._app_workspace_map = new_app_ws_map
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
                    f"Keyword cache refreshed - "
                    f"Workspaces: BL {len(new_blacklist_cache)}, WL {len(new_whitelist_cache)}; "
                    f"Lists: BL {blacklist_list_count}, WL {whitelist_list_count}; "
                    f"Keywords: BL {blacklist_keyword_count}, WL {whitelist_keyword_count}; "
                    f"App→Workspace mappings: {len(new_app_ws_map)}"
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
            "workspaces_with_blacklists": len(self._blacklist_cache),
            "workspaces_with_whitelists": len(self._whitelist_cache),
            "blacklist_lists": blacklist_list_count,
            "blacklist_keywords": blacklist_keyword_count,
            "whitelist_lists": whitelist_list_count,
            "whitelist_keywords": whitelist_keyword_count,
            "app_workspace_mappings": len(self._app_workspace_map),
            "last_refresh": self._cache_timestamp,
            "cache_age_seconds": time.time() - self._cache_timestamp if self._cache_timestamp > 0 else 0
        }

# Global keyword cache instance
keyword_cache = KeywordCache(cache_ttl=60)  # 1 minute cache
