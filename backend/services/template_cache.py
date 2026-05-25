import time
import asyncio
from typing import Dict, Optional, List
from sqlalchemy.orm import Session
from database.models import ResponseTemplate, Application
from database.connection import get_db_session
from utils.logger import setup_logger

logger = setup_logger()

class TemplateCache:
    """Response template cache service (workspace-scoped)"""

    def __init__(self, cache_ttl: int = 600):  # 10 minutes cache, template changes rarely
        # Workspace-scoped template cache structure: {workspace_id: {category: {is_default: template_content}}}
        self._template_cache: Dict[str, Dict[str, Dict[bool, str]]] = {}
        # App-to-workspace mapping cache: {application_id: workspace_id}
        self._app_workspace_map: Dict[str, str] = {}
        self._cache_timestamp = 0
        self._cache_ttl = cache_ttl
        self._lock = asyncio.Lock()

    async def get_suggest_answer(self, categories: List[str], tenant_id: Optional[str] = None, application_id: Optional[str] = None) -> str:
        """
        Get suggested answer (memory cache version)

        Args:
            categories: Risk categories
            tenant_id: DEPRECATED - kept for backward compatibility
            application_id: Application ID (resolved to workspace_id for lookup)
        """
        await self._ensure_cache_fresh()

        # Resolve application_id to workspace_id for cache lookup
        cache_key = None
        if application_id:
            cache_key = self._app_workspace_map.get(str(application_id))
        if not cache_key:
            cache_key = tenant_id

        if not categories:
            return self._get_default_answer(cache_key)
        
        try:
            # Define risk level priority
            risk_priority = {
                "high_risk": 3,
                "medium_risk": 2, 
                "low_risk": 1,
                "no_risk": 0
            }
            
            # Risk level mapping (must match RISK_LEVEL_MAPPING in guardrail_service.py)
            risk_level_mapping = {
                'S2': 'high_risk', 'S3': 'high_risk', 'S5': 'high_risk', 'S9': 'high_risk',
                'S15': 'high_risk', 'S17': 'high_risk',  # Weapons of Mass Destruction, Sexual Crimes
                'S4': 'medium_risk', 'S7': 'medium_risk', 'S16': 'medium_risk',  # Harm to Minors, Pornography, Self-Harm
                'S1': 'low_risk', 'S6': 'low_risk', 'S8': 'low_risk', 'S10': 'low_risk',
                'S11': 'low_risk', 'S12': 'low_risk', 'S13': 'low_risk', 'S14': 'low_risk',
                'S18': 'low_risk', 'S19': 'low_risk', 'S20': 'low_risk', 'S21': 'low_risk',
            }

            # Category name mapping (must match CATEGORY_NAMES in guardrail_service.py)
            category_names = {
                'S1': 'General Political Topics',
                'S2': 'Sensitive Political Topics',
                'S3': 'Insult to National Symbols or Leaders',
                'S4': 'Harm to Minors',
                'S5': 'Violent Crime',
                'S6': 'Non-Violent Crime',
                'S7': 'Pornography',
                'S8': 'Hate & Discrimination',
                'S9': 'Prompt Attacks',
                'S10': 'Profanity',
                'S11': 'Privacy Invasion',
                'S12': 'Commercial Violations',
                'S13': 'Intellectual Property Infringement',
                'S14': 'Harassment',
                'S15': 'Weapons of Mass Destruction',
                'S16': 'Self-Harm',
                'S17': 'Sexual Crimes',
                'S18': 'Threats',
                'S19': 'Professional Financial Advice',
                'S20': 'Professional Medical Advice',
                'S21': 'Professional Legal Advice',
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
                # First find template for "current workspace" (non-default priority), if not found, fallback to global default
                app_cache = self._template_cache.get(str(cache_key or "__none__"), {})
                if category_key in app_cache:
                    templates = app_cache[category_key]
                    if False in templates:  # Non-default template
                        return templates[False]
                    if True in templates:  # Default template
                        return templates[True]

                # Fallback to "global default" None template (for system-level default template)
                global_cache = self._template_cache.get("__global__", {})
                if category_key in global_cache:
                    templates = global_cache[category_key]
                    if True in templates:
                        return templates[True]

            return self._get_default_answer(cache_key)

        except Exception as e:
            logger.error(f"Get suggest answer error: {e}")
            return self._get_default_answer(None)

    def _get_default_answer(self, cache_key: Optional[str]) -> str:
        """Get default answer"""
        # First find workspace-defined default
        app_cache = self._template_cache.get(str(cache_key or "__none__"), {})
        if "default" in app_cache and True in app_cache["default"]:
            return app_cache["default"][True]
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
        """Refresh cache (workspace-scoped)"""
        try:
            db = get_db_session()
            try:
                # Build app-to-workspace mapping
                app_workspace_map: Dict[str, str] = {}
                app_records = db.query(Application.id, Application.workspace_id).filter(
                    Application.workspace_id.isnot(None)
                ).all()
                for app in app_records:
                    app_workspace_map[str(app.id)] = str(app.workspace_id)
                self._app_workspace_map = app_workspace_map

                # Load all enabled response templates, keyed by workspace_id
                templates = db.query(ResponseTemplate).filter_by(is_active=True).all()
                new_cache: Dict[str, Dict[str, Dict[bool, str]]] = {}
                for template in templates:
                    if template.application_id is not None:
                        # Resolve application_id to workspace_id
                        ws_key = app_workspace_map.get(str(template.application_id))
                        if not ws_key:
                            # Fallback: skip templates for apps without a workspace
                            continue
                    else:
                        # Global templates (no application_id)
                        ws_key = "__global__"

                    category = template.category
                    is_default = template.is_default
                    content = template.template_content

                    if ws_key not in new_cache:
                        new_cache[ws_key] = {}
                    if category not in new_cache[ws_key]:
                        new_cache[ws_key][category] = {}
                    new_cache[ws_key][category][is_default] = content

                # Atomic update cache
                self._template_cache = new_cache
                self._cache_timestamp = time.time()

                template_count = sum(
                    sum(len(templates) for templates in ws_categories.values())
                    for ws_categories in new_cache.values()
                )
                logger.debug(
                    f"Template cache refreshed - Workspaces: {len(new_cache)}, Templates: {template_count}, App mappings: {len(app_workspace_map)}"
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
            sum(len(templates) for templates in app_categories.values())
            for app_categories in self._template_cache.values()
        )

        return {
            "workspaces": len(self._template_cache),
            "templates": template_count,
            "app_workspace_mappings": len(self._app_workspace_map),
            "last_refresh": self._cache_timestamp,
            "cache_age_seconds": time.time() - self._cache_timestamp if self._cache_timestamp > 0 else 0
        }

# Global template cache instance
template_cache = TemplateCache(cache_ttl=600)  # 10 minutes cache