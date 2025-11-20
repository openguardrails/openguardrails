"""
Enhanced template service
Combine traditional template and knowledge base question-answer pairs, provide more intelligent answer functionality
"""
import time
import asyncio
from typing import Dict, Optional, List, Tuple
from sqlalchemy.orm import Session
from database.models import ResponseTemplate, KnowledgeBase, TenantKnowledgeBaseDisable
from database.connection import get_db_session
from services.knowledge_base_service import knowledge_base_service
from utils.logger import setup_logger

logger = setup_logger()

class EnhancedTemplateService:
    """Enhanced template service, support knowledge base search"""

    def __init__(self, cache_ttl: int = 600):
        # Template cache
        self._template_cache: Dict[str, Dict[str, Dict[bool, str]]] = {}
        # Knowledge base cache: {application_id: {category: [knowledge_base_ids]}}
        self._knowledge_base_cache: Dict[str, Dict[str, List[int]]] = {}
        # Global knowledge base cache: {category: [knowledge_base_ids]}
        self._global_knowledge_base_cache: Dict[str, List[int]] = {}
        # Tenant disabled KB cache: {tenant_id: set(kb_ids)}
        self._tenant_disabled_kb_cache: Dict[str, set] = {}
        self._cache_timestamp = 0
        self._cache_ttl = cache_ttl
        self._lock = asyncio.Lock()

    async def get_suggest_answer(self, categories: List[str], tenant_id: Optional[str] = None, application_id: Optional[str] = None, user_query: Optional[str] = None, user_language: Optional[str] = None, scanner_type: Optional[str] = None, scanner_identifier: Optional[str] = None, scanner_name: Optional[str] = None) -> str:
        """
        Get suggested answer, first search from knowledge base, if not found, use default template
        Args:
            categories: Risk categories list (legacy, for backward compatibility)
            tenant_id: DEPRECATED - kept for backward compatibility
            application_id: Application ID for multi-application support
            user_query: User original question (for knowledge base search)
            user_language: User's preferred language (e.g., 'en', 'zh')
            scanner_type: Scanner type (blacklist, whitelist, official_scanner, marketplace_scanner, custom_scanner)
            scanner_identifier: Scanner identifier (blacklist name, whitelist name, or scanner tag like S1, S100)
            scanner_name: Human-readable scanner name for {scanner_name} variable in templates
        Returns:
            Suggested answer content
        """
        await self._ensure_cache_fresh()

        # If neither categories nor scanner info provided, return default
        if not categories and not (scanner_type and scanner_identifier):
            return self._get_default_answer(application_id, user_language, scanner_name)

        try:
            # 1. Try to get answer from knowledge base
            if user_query and user_query.strip():
                logger.debug(f"Knowledge base search: application_id={application_id}, tenant_id={tenant_id}, user_query={user_query[:50]}..., categories={categories}, scanner_type={scanner_type}, scanner_identifier={scanner_identifier}")
                kb_answer = await self._search_knowledge_base_answer(
                    categories=categories,
                    tenant_id=tenant_id,
                    application_id=application_id,
                    user_query=user_query.strip(),
                    scanner_type=scanner_type,
                    scanner_identifier=scanner_identifier
                )
                if kb_answer:
                    logger.info(f"Found answer from knowledge base for application {application_id}, scanner={scanner_type}/{scanner_identifier}, query: {user_query[:50]}...")
                    # Replace {scanner_name} variable in KB answer if provided
                    if scanner_name and '{scanner_name}' in kb_answer:
                        kb_answer = kb_answer.replace('{scanner_name}', scanner_name)
                    return kb_answer
                else:
                    logger.debug(f"No answer found in knowledge base for application {application_id}, query: {user_query[:50]}...")

            # 2. Knowledge base didn't find answer, use traditional template logic
            return await self._get_template_answer(
                categories=categories,
                application_id=application_id,
                user_language=user_language,
                scanner_type=scanner_type,
                scanner_identifier=scanner_identifier,
                scanner_name=scanner_name
            )

        except Exception as e:
            logger.error(f"Get suggest answer error: {e}")
            return self._get_default_answer(application_id, user_language, scanner_name)

    async def _search_knowledge_base_answer(self, categories: List[str], tenant_id: Optional[str], application_id: Optional[str], user_query: str, scanner_type: Optional[str] = None, scanner_identifier: Optional[str] = None) -> Optional[str]:
        """Search answer from knowledge base"""
        # If no application_id, try to find default application from tenant_id
        if not application_id and tenant_id:
            try:
                from database.connection import get_db_session
                from database.models import Application
                import uuid as uuid_module
                
                db = get_db_session()
                try:
                    tenant_uuid = uuid_module.UUID(str(tenant_id))
                    default_app = db.query(Application).filter(
                        Application.tenant_id == tenant_uuid,
                        Application.is_active == True
                    ).order_by(Application.created_at.asc()).first()
                    
                    if default_app:
                        application_id = str(default_app.id)
                        logger.debug(f"Knowledge base search: Using default application {application_id} for tenant {tenant_id}")
                finally:
                    db.close()
            except (ValueError, Exception) as e:
                logger.warning(f"Knowledge base search: Failed to find default application for tenant {tenant_id}: {e}")
        
        if not application_id:
            logger.warning("Knowledge base search: No application_id available, skipping search")
            return None

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

            # Search knowledge base by scanner_type/scanner_identifier first, then by category
            app_cache = self._knowledge_base_cache.get(str(application_id), {})
            logger.debug(f"Knowledge base cache for application {application_id}: {list(app_cache.keys())} keys")
            logger.debug(f"Global knowledge base cache: {list(self._global_knowledge_base_cache.keys())} keys")

            # Priority 1: Search by scanner_type:scanner_identifier if provided
            if scanner_type and scanner_identifier:
                scanner_key = f"{scanner_type}:{scanner_identifier}"
                logger.debug(f"Searching KB by scanner key: {scanner_key}")

                # Collect knowledge base IDs for this scanner
                knowledge_base_ids = app_cache.get(scanner_key, []).copy()
                global_kb_ids = self._global_knowledge_base_cache.get(scanner_key, [])

                # Filter out disabled global KBs for this tenant
                disabled_kb_ids = self._tenant_disabled_kb_cache.get(str(tenant_id), set())
                filtered_global_kb_ids = [kb_id for kb_id in global_kb_ids if kb_id not in disabled_kb_ids]
                knowledge_base_ids.extend(filtered_global_kb_ids)
                knowledge_base_ids = list(set(knowledge_base_ids))

                logger.debug(f"Found {len(knowledge_base_ids)} KBs for scanner {scanner_key}")

                # Search these knowledge bases
                from database.connection import get_db_session
                db = get_db_session()
                try:
                    for kb_id in knowledge_base_ids:
                        try:
                            logger.debug(f"Searching KB {kb_id} with query: {user_query[:50]}...")
                            results = knowledge_base_service.search_similar_questions(
                                user_query,
                                kb_id,
                                top_k=1,
                                db=db
                            )

                            if results:
                                best_result = results[0]
                                kb_type = "global" if kb_id in global_kb_ids else "application"
                                logger.info(f"Found similar question in {kb_type} KB {kb_id}: similarity={best_result['similarity_score']:.3f}, query: {user_query[:50]}...")
                                return best_result['answer']
                        except Exception as e:
                            logger.warning(f"Error searching knowledge base {kb_id}: {e}", exc_info=True)
                            continue
                finally:
                    db.close()

            # Priority 2: Search by legacy category
            for category_key, risk_level, priority in category_risk_mapping:
                # Collect knowledge base IDs to search: application's own + global
                knowledge_base_ids = app_cache.get(category_key, []).copy()
                global_kb_ids = self._global_knowledge_base_cache.get(category_key, [])
                
                logger.debug(f"Category {category_key}: app KBs={len(knowledge_base_ids)}, global KBs={len(global_kb_ids)}")

                # Filter out disabled global KBs for this tenant
                disabled_kb_ids = self._tenant_disabled_kb_cache.get(str(tenant_id), set())
                filtered_global_kb_ids = [kb_id for kb_id in global_kb_ids if kb_id not in disabled_kb_ids]

                knowledge_base_ids.extend(filtered_global_kb_ids)

                # Remove duplicates
                knowledge_base_ids = list(set(knowledge_base_ids))
                
                logger.debug(f"Total KBs to search for category {category_key}: {len(knowledge_base_ids)}")

                # Get database session for fetching KB's similarity threshold
                from database.connection import get_db_session
                db = get_db_session()
                try:
                    for kb_id in knowledge_base_ids:
                        try:
                            logger.debug(f"Searching KB {kb_id} with query: {user_query[:50]}...")
                            # Search similar questions (will use KB's configured threshold)
                            results = knowledge_base_service.search_similar_questions(
                                user_query,
                                kb_id,
                                top_k=1,
                                db=db
                            )

                            if results:
                                best_result = results[0]
                                kb_type = "global" if kb_id in global_kb_ids else "application"
                                logger.info(f"Found similar question in {kb_type} KB {kb_id}: similarity={best_result['similarity_score']:.3f}, query: {user_query[:50]}...")
                                return best_result['answer']
                            else:
                                logger.debug(f"No similar questions found in KB {kb_id} for query: {user_query[:50]}...")

                        except Exception as e:
                            logger.warning(f"Error searching knowledge base {kb_id}: {e}", exc_info=True)
                            continue
                finally:
                    db.close()

            return None

        except Exception as e:
            logger.error(f"Search knowledge base answer error: {e}")
            return None

    async def _get_template_answer(self, categories: List[str], application_id: Optional[str], user_language: Optional[str] = None, scanner_type: Optional[str] = None, scanner_identifier: Optional[str] = None, scanner_name: Optional[str] = None) -> str:
        """Use traditional template to get answer"""
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

            # Priority 1: If scanner_type and scanner_identifier provided, search by scanner info first
            if scanner_type and scanner_identifier:
                # Build scanner cache key: "scanner_type:scanner_identifier"
                scanner_key = f"{scanner_type}:{scanner_identifier}"

                # Search in application cache
                app_cache = self._template_cache.get(str(application_id or "__none__"), {})
                if scanner_key in app_cache:
                    templates = app_cache[scanner_key]
                    if False in templates:  # Non-default template
                        answer = self._get_localized_content(templates[False], user_language)
                        if scanner_name and '{scanner_name}' in answer:
                            answer = answer.replace('{scanner_name}', scanner_name)
                        return answer
                    if True in templates:  # Default template
                        answer = self._get_localized_content(templates[True], user_language)
                        if scanner_name and '{scanner_name}' in answer:
                            answer = answer.replace('{scanner_name}', scanner_name)
                        return answer

                # Search in global cache
                global_cache = self._template_cache.get("__global__", {})
                if scanner_key in global_cache:
                    templates = global_cache[scanner_key]
                    if True in templates:
                        answer = self._get_localized_content(templates[True], user_language)
                        if scanner_name and '{scanner_name}' in answer:
                            answer = answer.replace('{scanner_name}', scanner_name)
                        return answer

            # Priority 2: Find template by highest risk level (legacy category-based lookup)
            for category_key, risk_level, priority in category_risk_mapping:
                # First find template for "current application" (non-default priority), if not found, fallback to global default
                app_cache = self._template_cache.get(str(application_id or "__none__"), {})
                if category_key in app_cache:
                    templates = app_cache[category_key]
                    if False in templates:  # Non-default template
                        answer = self._get_localized_content(templates[False], user_language)
                        if scanner_name and '{scanner_name}' in answer:
                            answer = answer.replace('{scanner_name}', scanner_name)
                        return answer
                    if True in templates:  # Default template
                        answer = self._get_localized_content(templates[True], user_language)
                        if scanner_name and '{scanner_name}' in answer:
                            answer = answer.replace('{scanner_name}', scanner_name)
                        return answer

                # Fallback to "global default" None template (for system-level default template)
                global_cache = self._template_cache.get("__global__", {})
                if category_key in global_cache:
                    templates = global_cache[category_key]
                    if True in templates:
                        answer = self._get_localized_content(templates[True], user_language)
                        if scanner_name and '{scanner_name}' in answer:
                            answer = answer.replace('{scanner_name}', scanner_name)
                        return answer

            return self._get_default_answer(application_id, user_language, scanner_name)

        except Exception as e:
            logger.error(f"Get template answer error: {e}")
            return self._get_default_answer(application_id, user_language, scanner_name)

    def _get_localized_content(self, content: any, user_language: Optional[str] = None) -> str:
        """
        Get localized content from template content
        Args:
            content: Template content (can be str or dict)
            user_language: User's preferred language
        Returns:
            Localized string
        """
        # If content is already a string (backward compatibility), return as-is
        if isinstance(content, str):
            return content

        # If content is a dict (new JSON format)
        if isinstance(content, dict):
            # Determine language to use
            lang = user_language or 'en'  # Default to English

            # Try exact match first
            if lang in content:
                return content[lang]

            # Fallback to English
            if 'en' in content:
                return content['en']

            # Fallback to first available language
            if content:
                return next(iter(content.values()))

        # Fallback to generic message
        return "Sorry, I can't answer this question. If you have any questions, please contact customer service."

    def _get_default_answer(self, application_id: Optional[str] = None, user_language: Optional[str] = None, scanner_name: Optional[str] = None) -> str:
        """Get default answer"""
        # First find application-defined default
        app_cache = self._template_cache.get(str(application_id or "__none__"), {})
        if "default" in app_cache and True in app_cache["default"]:
            answer = self._get_localized_content(app_cache["default"][True], user_language)
            # Replace {scanner_name} variable if provided
            if scanner_name and '{scanner_name}' in answer:
                answer = answer.replace('{scanner_name}', scanner_name)
            return answer
        # Then fallback to global default
        global_cache = self._template_cache.get("__global__", {})
        if "default" in global_cache and True in global_cache["default"]:
            answer = self._get_localized_content(global_cache["default"][True], user_language)
            # Replace {scanner_name} variable if provided
            if scanner_name and '{scanner_name}' in answer:
                answer = answer.replace('{scanner_name}', scanner_name)
            return answer

        # Final fallback with multilingual support
        default_messages = {
            'en': "Sorry, I can't provide content involving {scanner_name}." if scanner_name else "Sorry, I can't answer this question. If you have any questions, please contact customer service.",
            'zh': f"抱歉,我无法提供涉及{scanner_name}的内容。" if scanner_name else "抱歉，我无法回答这个问题。如有任何疑问，请联系客服。"
        }
        lang = user_language or 'en'
        answer = default_messages.get(lang, default_messages['en'])
        # Replace {scanner_name} variable if provided
        if scanner_name and '{scanner_name}' in answer:
            answer = answer.replace('{scanner_name}', scanner_name)
        return answer

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
                # 1. Load all enabled response templates
                templates = db.query(ResponseTemplate).filter_by(is_active=True).all()
                new_template_cache: Dict[str, Dict[str, Dict[bool, str]]] = {}

                for template in templates:
                    # Use application_id as cache key (application-scoped), consistent with knowledge bases
                    app_key = str(template.application_id) if template.application_id is not None else "__global__"
                    is_default = template.is_default
                    content = template.template_content

                    # Support both new scanner_type/scanner_identifier and legacy category field
                    cache_key = None
                    if template.scanner_type and template.scanner_identifier:
                        # New format: "scanner_type:scanner_identifier"
                        cache_key = f"{template.scanner_type}:{template.scanner_identifier}"
                    elif template.category:
                        # Legacy format: use category as-is
                        cache_key = template.category

                    if cache_key:
                        if app_key not in new_template_cache:
                            new_template_cache[app_key] = {}
                        if cache_key not in new_template_cache[app_key]:
                            new_template_cache[app_key][cache_key] = {}
                        new_template_cache[app_key][cache_key][is_default] = content

                # 2. Load all enabled knowledge bases
                knowledge_bases = db.query(KnowledgeBase).filter_by(is_active=True).all()
                new_kb_cache: Dict[str, Dict[str, List[int]]] = {}
                # Global knowledge base cache: {category: [knowledge_base_ids]}
                global_kb_cache: Dict[str, List[int]] = {}

                for kb in knowledge_bases:
                    # Use application_id as cache key (application-scoped)
                    app_key = str(kb.application_id) if kb.application_id else None
                    if not app_key:
                        # Skip entries without application_id (shouldn't happen after migration)
                        logger.warning(f"Knowledge base {kb.id} has no application_id, skipping")
                        continue

                    # Support both new scanner_type/scanner_identifier and legacy category field
                    cache_key = None
                    if kb.scanner_type and kb.scanner_identifier:
                        # New format: "scanner_type:scanner_identifier"
                        cache_key = f"{kb.scanner_type}:{kb.scanner_identifier}"
                    elif kb.category:
                        # Legacy format: use category as-is
                        cache_key = kb.category

                    if not cache_key:
                        logger.warning(f"Knowledge base {kb.id} has neither scanner info nor category, skipping")
                        continue

                    # Application's own knowledge base
                    if app_key not in new_kb_cache:
                        new_kb_cache[app_key] = {}
                    if cache_key not in new_kb_cache[app_key]:
                        new_kb_cache[app_key][cache_key] = []
                    new_kb_cache[app_key][cache_key].append(kb.id)

                    # Global knowledge base
                    if kb.is_global:
                        if cache_key not in global_kb_cache:
                            global_kb_cache[cache_key] = []
                        global_kb_cache[cache_key].append(kb.id)

                # Save global knowledge base cache
                self._global_knowledge_base_cache = global_kb_cache

                # 3. Load tenant disabled KB records
                tenant_disabled_kb_cache: Dict[str, set] = {}
                disabled_records = db.query(TenantKnowledgeBaseDisable).all()
                for record in disabled_records:
                    tenant_key = str(record.tenant_id)
                    if tenant_key not in tenant_disabled_kb_cache:
                        tenant_disabled_kb_cache[tenant_key] = set()
                    tenant_disabled_kb_cache[tenant_key].add(record.kb_id)

                # Save tenant disabled KB cache
                self._tenant_disabled_kb_cache = tenant_disabled_kb_cache

                # 4. Atomic update cache
                self._template_cache = new_template_cache
                self._knowledge_base_cache = new_kb_cache
                self._cache_timestamp = time.time()

                template_count = sum(
                    sum(len(templates) for templates in user_categories.values())
                    for user_categories in new_template_cache.values()
                )
                kb_count = sum(
                    sum(len(kb_ids) for kb_ids in user_categories.values())
                    for user_categories in new_kb_cache.values()
                )

                logger.debug(
                    f"Enhanced template cache refreshed - Applications: {len(new_template_cache)}, "
                    f"Templates: {template_count}, Knowledge Bases: {kb_count}"
                )

            finally:
                db.close()

        except Exception as e:
            logger.error(f"Failed to refresh enhanced template cache: {e}")

    async def invalidate_cache(self):
        """Immediately invalidate cache"""
        async with self._lock:
            self._cache_timestamp = 0
            logger.info("Enhanced template cache invalidated")

    def get_cache_info(self) -> dict:
        """Get cache statistics"""
        template_count = sum(
            sum(len(templates) for templates in user_categories.values())
            for user_categories in self._template_cache.values()
        )

        kb_count = sum(
            sum(len(kb_ids) for kb_ids in user_categories.values())
            for user_categories in self._knowledge_base_cache.values()
        )

        global_kb_count = sum(len(kb_ids) for kb_ids in self._global_knowledge_base_cache.values())

        return {
            "applications": len(self._template_cache),
            "templates": template_count,
            "knowledge_bases": kb_count,
            "global_knowledge_bases": global_kb_count,
            "last_refresh": self._cache_timestamp,
            "cache_age_seconds": time.time() - self._cache_timestamp if self._cache_timestamp > 0 else 0
        }

# Global enhanced template service instance
enhanced_template_service = EnhancedTemplateService(cache_ttl=600)  # 10 minutes cache