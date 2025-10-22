import time
import asyncio
from typing import Dict, Optional, List
from sqlalchemy.orm import Session
from database.models import ResponseTemplate
from database.connection import get_db_session
from utils.logger import setup_logger

logger = setup_logger()

class TemplateCache:
    """Response template cache service"""
    
    def __init__(self, cache_ttl: int = 600):  # 10 minutes cache, template changes rarely
        # Multi-tenant template cache structure: {tenant_id: {category: {is_default: template_content}}}
        self._template_cache: Dict[str, Dict[str, Dict[bool, str]]] = {}
        self._cache_timestamp = 0
        self._cache_ttl = cache_ttl
        self._lock = asyncio.Lock()
        
    async def get_suggest_answer(self, categories: List[str], tenant_id: Optional[str] = None) -> str:
        """Get suggested answer (memory cache version)"""
        await self._ensure_cache_fresh()
        
        if not categories:
            return self._get_default_answer(tenant_id)
        
        try:
            # Define risk level priority
            risk_priority = {
                "high_risk": 3,
                "medium_risk": 2, 
                "low_risk": 1,
                "no_risk": 0
            }
            
            # Risk level mapping
            risk_level_mapping = {
                'S2': 'high_risk', 'S3': 'high_risk', 'S5': 'high_risk', 'S9': 'high_risk',
                'S1': 'medium_risk', 'S4': 'medium_risk', 'S6': 'medium_risk', 'S7': 'medium_risk',
                'S8': 'low_risk', 'S10': 'low_risk', 'S11': 'low_risk', 'S12': 'low_risk',
            }
            
            # Category name mapping
            category_names = {
                'S1': 'General Political Topics', 'S2': 'Sensitive Political Topics', 'S3': 'Damage to National Image',
                'S4': 'Harm to Minors', 'S5': 'Violent Crime', 'S6': 'Illegal Activities',
                'S7': 'Pornography', 'S8': 'Discriminatory Content', 'S9': 'Prompt Injection',
                'S10': 'Insults', 'S11': 'Privacy Violation', 'S12': 'Business Violations',
            }
            
            # Convert category name to category code, and calculate risk level
            category_risk_mapping = []
            for category in categories:
                category_key = None
                for key, name in category_names.items():
                    if name == category:
                        category_key = key
                        break
                
                if category_key:
                    risk_level = risk_level_mapping.get(category_key, "low_risk")
                    priority = risk_priority.get(risk_level, 0)
                    category_risk_mapping.append((category_key, risk_level, priority))
            
            # Sort by risk level, higher priority first
            category_risk_mapping.sort(key=lambda x: x[2], reverse=True)
            
            # Find template by highest risk level
            for category_key, risk_level, priority in category_risk_mapping:
                # First find template for "current user" (non-default priority), if not found, fallback to global default
                user_cache = self._template_cache.get(str(tenant_id or "__none__"), {})
                if category_key in user_cache:
                    templates = user_cache[category_key]
                    if False in templates:  # Non-default template
                        return templates[False]
                    if True in templates:  # Default template
                        return templates[True]

                # Fallback to "global default user" None template (for system-level default template)
                global_cache = self._template_cache.get("__global__", {})
                if category_key in global_cache:
                    templates = global_cache[category_key]
                    if True in templates:
                        return templates[True]

            return self._get_default_answer(tenant_id)
            
        except Exception as e:
            logger.error(f"Get suggest answer error: {e}")
            return self._get_default_answer()
    
    def _get_default_answer(self, tenant_id: Optional[str]) -> str:
        """Get default answer"""
        # First find user-defined default
        user_cache = self._template_cache.get(str(tenant_id or "__none__"), {})
        if "default" in user_cache and True in user_cache["default"]:
            return user_cache["default"][True]
        # Fallback to global default
        global_cache = self._template_cache.get("__global__", {})
        if "default" in global_cache and True in global_cache["default"]:
            return global_cache["default"][True]
        return "Sorry, I can't answer this question. Please contact customer service if you have any questions."
    
    async def _ensure_cache_fresh(self):
        """Ensure cache is fresh"""
        current_time = time.time()
        
        if current_time - self._cache_timestamp > self._cache_ttl:
            async with self._lock:
                # Double-check lock
                if current_time - self._cache_timestamp > self._cache_ttl:
                    await self._refresh_cache()
    
    async def _refresh_cache(self):
        """Refresh cache"""
        try:
            db = get_db_session()
            try:
                # Load all enabled response templates (grouped by user, None represents global default template)
                templates = db.query(ResponseTemplate).filter_by(is_active=True).all()
                new_cache: Dict[str, Dict[str, Dict[bool, str]]] = {}
                for template in templates:
                    user_key = str(template.tenant_id) if template.tenant_id is not None else "__global__"
                    category = template.category
                    is_default = template.is_default
                    content = template.template_content

                    if user_key not in new_cache:
                        new_cache[user_key] = {}
                    if category not in new_cache[user_key]:
                        new_cache[user_key][category] = {}
                    new_cache[user_key][category][is_default] = content
                
                # Atomic update cache
                self._template_cache = new_cache
                self._cache_timestamp = time.time()
                
                template_count = sum(
                    sum(len(templates) for templates in user_categories.values())
                    for user_categories in new_cache.values()
                )
                logger.debug(
                    f"Template cache refreshed - Users: {len(new_cache)}, Templates: {template_count}"
                )
                
            finally:
                db.close()
                
        except Exception as e:
            logger.error(f"Failed to refresh template cache: {e}")
    
    async def invalidate_cache(self):
        """Immediately invalidate cache"""
        async with self._lock:
            self._cache_timestamp = 0
            logger.info("Template cache invalidated")
    
    def get_cache_info(self) -> dict:
        """Get cache statistics"""
        template_count = sum(
            sum(len(templates) for templates in user_categories.values())
            for user_categories in self._template_cache.values()
        )
        
        return {
            "users": len(self._template_cache),
            "templates": template_count,
            "last_refresh": self._cache_timestamp,
            "cache_age_seconds": time.time() - self._cache_timestamp if self._cache_timestamp > 0 else 0
        }

# Global template cache instance
template_cache = TemplateCache(cache_ttl=600)  # 10 minutes cache