"""
Enhanced Template Service

Provides intelligent answer generation for blocked content:
1. Proxy Answer (代答): When knowledge base is hit, generate safe response using guardrail model
2. Fixed Answer (据答): When no KB hit, use generic template with scanner_name

Flow:
  User Query → Risk Detected → Search Knowledge Base
                                    ↓
                           ┌───────┴───────┐
                           ↓               ↓
                      KB Hit           KB Miss
                           ↓               ↓
                  Generate Proxy    Return Fixed
                  Answer (Model)    Answer (Template)
                           ↓               ↓
                      Safe Response   Template Response
"""
import time
import asyncio
from typing import Dict, Optional, List
from sqlalchemy.orm import Session

from database.models import KnowledgeBase, TenantKnowledgeBaseDisable
from database.connection import get_db_session
from services.knowledge_base_service import knowledge_base_service
from services.proxy_answer_service import proxy_answer_service
from utils.logger import setup_logger
from utils.i18n_loader import get_translation

logger = setup_logger()


class EnhancedTemplateService:
    """Enhanced template service with proxy answer generation"""

    def __init__(self, cache_ttl: int = 600):
        # Knowledge base cache: {application_id: {scanner_key: [kb_ids]}}
        self._knowledge_base_cache: Dict[str, Dict[str, List[int]]] = {}
        # Global knowledge base cache: {scanner_key: [kb_ids]}
        self._global_knowledge_base_cache: Dict[str, List[int]] = {}
        # Tenant disabled KB cache: {tenant_id: set(kb_ids)}
        self._tenant_disabled_kb_cache: Dict[str, set] = {}
        self._cache_timestamp = 0
        self._cache_ttl = cache_ttl
        self._lock = asyncio.Lock()

    async def get_suggest_answer(
        self,
        categories: List[str],
        tenant_id: Optional[str] = None,
        application_id: Optional[str] = None,
        user_query: Optional[str] = None,
        user_language: Optional[str] = None,
        scanner_type: Optional[str] = None,
        scanner_identifier: Optional[str] = None,
        scanner_name: Optional[str] = None
    ) -> str:
        """
        Get suggested answer - proxy answer (代答) or fixed answer (据答).

        Flow:
        1. If user_query provided, search knowledge base
        2. If KB hit, generate proxy answer using guardrail model
        3. If KB miss or no user_query, return fixed answer template

        Args:
            categories: Risk categories list
            tenant_id: Tenant ID
            application_id: Application ID
            user_query: User's original question (for KB search and proxy answer)
            user_language: User's preferred language ('en', 'zh')
            scanner_type: Scanner type
            scanner_identifier: Scanner identifier (e.g., S8, S100)
            scanner_name: Human-readable scanner name

        Returns:
            Suggested answer (proxy or fixed)
        """
        await self._ensure_cache_fresh()

        lang = user_language or 'en'

        # If no scanner_name provided, try to extract from categories
        if not scanner_name and categories:
            scanner_name = categories[0]

        # If no scanner_name still, use default
        if not scanner_name:
            scanner_name = "policy violation" if lang != 'zh' else "政策违规"

        # Try proxy answer (代答) if user_query is provided
        if user_query and user_query.strip() and application_id:
            try:
                kb_answer = await self._search_and_generate_proxy_answer(
                    user_query=user_query.strip(),
                    tenant_id=tenant_id,
                    application_id=application_id,
                    scanner_type=scanner_type,
                    scanner_identifier=scanner_identifier,
                    scanner_name=scanner_name,
                    categories=categories,
                    user_language=lang
                )
                if kb_answer:
                    return kb_answer
            except Exception as e:
                logger.error(f"Proxy answer generation failed: {e}", exc_info=True)

        # Fallback to fixed answer (据答)
        return self._get_fixed_answer(scanner_name, lang)

    async def _search_and_generate_proxy_answer(
        self,
        user_query: str,
        tenant_id: Optional[str],
        application_id: str,
        scanner_type: Optional[str],
        scanner_identifier: Optional[str],
        scanner_name: str,
        categories: List[str],
        user_language: str
    ) -> Optional[str]:
        """
        Search knowledge base and generate proxy answer if hit.

        Args:
            user_query: User's original question
            tenant_id: Tenant ID
            application_id: Application ID
            scanner_type: Scanner type
            scanner_identifier: Scanner identifier
            scanner_name: Human-readable scanner name
            categories: Risk categories
            user_language: User's preferred language

        Returns:
            Generated proxy answer or None if no KB hit
        """
        # Search knowledge base
        kb_content = await self._search_knowledge_base(
            user_query=user_query,
            tenant_id=tenant_id,
            application_id=application_id,
            scanner_type=scanner_type,
            scanner_identifier=scanner_identifier,
            categories=categories
        )

        if not kb_content:
            logger.debug(f"No KB hit for query: {user_query[:50]}...")
            return None

        # Generate proxy answer using guardrail model
        logger.info(f"KB hit, generating proxy answer for scanner: {scanner_name}")

        proxy_answer = await proxy_answer_service.generate_proxy_answer(
            user_query=user_query,
            kb_reference=kb_content,
            scanner_name=scanner_name,
            risk_level="medium_risk",  # Could be passed from caller
            user_language=user_language
        )

        return proxy_answer

    async def _search_knowledge_base(
        self,
        user_query: str,
        tenant_id: Optional[str],
        application_id: str,
        scanner_type: Optional[str],
        scanner_identifier: Optional[str],
        categories: List[str]
    ) -> Optional[str]:
        """
        Search knowledge base for similar content.

        Returns:
            KB answer content if found, None otherwise
        """
        try:
            app_cache = self._knowledge_base_cache.get(str(application_id), {})

            # Priority 1: Search by scanner_type:scanner_identifier
            if scanner_type and scanner_identifier:
                scanner_key = f"{scanner_type}:{scanner_identifier}"
                kb_ids = self._get_kb_ids_for_key(scanner_key, app_cache, tenant_id)

                if kb_ids:
                    result = await self._search_kb_ids(kb_ids, user_query)
                    if result:
                        return result

            # Priority 2: Search by category
            for category in categories:
                # Try to map category name to code
                category_key = self._get_category_key(category)
                if category_key:
                    kb_ids = self._get_kb_ids_for_key(category_key, app_cache, tenant_id)
                    if kb_ids:
                        result = await self._search_kb_ids(kb_ids, user_query)
                        if result:
                            return result

            return None

        except Exception as e:
            logger.error(f"Knowledge base search error: {e}", exc_info=True)
            return None

    def _get_kb_ids_for_key(
        self,
        cache_key: str,
        app_cache: Dict[str, List[int]],
        tenant_id: Optional[str]
    ) -> List[int]:
        """Get KB IDs for a cache key, including global KBs"""
        kb_ids = app_cache.get(cache_key, []).copy()
        global_kb_ids = self._global_knowledge_base_cache.get(cache_key, [])

        # Filter out disabled global KBs for this tenant
        disabled_kb_ids = self._tenant_disabled_kb_cache.get(str(tenant_id), set()) if tenant_id else set()
        filtered_global_kb_ids = [kb_id for kb_id in global_kb_ids if kb_id not in disabled_kb_ids]

        kb_ids.extend(filtered_global_kb_ids)
        return list(set(kb_ids))

    async def _search_kb_ids(self, kb_ids: List[int], user_query: str) -> Optional[str]:
        """Search through KB IDs and return first matching answer"""
        db = get_db_session()
        try:
            for kb_id in kb_ids:
                try:
                    results = knowledge_base_service.search_similar_questions(
                        user_query,
                        kb_id,
                        top_k=1,
                        db=db
                    )
                    if results:
                        logger.info(f"KB {kb_id} hit with similarity: {results[0]['similarity_score']:.3f}")
                        return results[0]['answer']
                except Exception as e:
                    logger.warning(f"Error searching KB {kb_id}: {e}")
                    continue
            return None
        finally:
            db.close()

    def _get_category_key(self, category: str) -> Optional[str]:
        """Map category name to category key (S1-S21)"""
        category_mapping = {
            'General Political Topics': 'S1',
            'Sensitive Political Topics': 'S2',
            'Insult to National Symbols or Leaders': 'S3',
            'Harm to Minors': 'S4',
            'Violent Crime': 'S5',
            'Non-Violent Crime': 'S6',
            'Pornography': 'S7',
            'Hate & Discrimination': 'S8',
            'Prompt Attacks': 'S9',
            'Profanity': 'S10',
            'Privacy Invasion': 'S11',
            'Commercial Violations': 'S12',
            'Intellectual Property Infringement': 'S13',
            'Harassment': 'S14',
            'Weapons of Mass Destruction': 'S15',
            'Self-Harm': 'S16',
            'Sexual Crimes': 'S17',
            'Threats': 'S18',
            'Professional Financial Advice': 'S19',
            'Professional Medical Advice': 'S20',
            'Professional Legal Advice': 'S21',
        }
        return category_mapping.get(category)

    def _get_fixed_answer(self, scanner_name: str, language: str) -> str:
        """
        Get fixed answer (据答) using generic template.

        Args:
            scanner_name: Human-readable scanner name
            language: User's preferred language

        Returns:
            Fixed answer with scanner_name filled in
        """
        try:
            template = get_translation(language, 'guardrail', 'responseTemplates', 'securityRisk')
        except KeyError:
            try:
                template = get_translation(language, 'guardrail', 'responseTemplates', 'default')
            except KeyError:
                if language == 'zh':
                    template = "请求已被OpenGuardrails拦截，原因：可能违反了与{scanner_name}有关的策略要求。"
                else:
                    template = "Request blocked by OpenGuardrails due to possible violation of policy related to {scanner_name}."

        if '{scanner_name}' in template:
            return template.replace('{scanner_name}', scanner_name)
        return template

    async def get_data_leakage_answer(
        self,
        entity_types: List[str],
        user_language: Optional[str] = None
    ) -> str:
        """
        Get suggested answer for data leakage risk using generic template.

        Args:
            entity_types: List of detected entity type names
            user_language: User's preferred language

        Returns:
            Answer with entity types filled in
        """
        lang = user_language or 'en'

        try:
            template = get_translation(lang, 'guardrail', 'responseTemplates', 'dataLeakageRisk')
        except KeyError:
            if lang == 'zh':
                template = "请求已被OpenGuardrails拦截，原因：可能包含敏感数据（{entity_type_names}）。"
            else:
                template = "Request blocked by OpenGuardrails due to possible sensitive data ({entity_type_names})."

        # Format entity type names list
        if entity_types:
            if lang == 'zh':
                entity_type_names_str = '、'.join(entity_types)
            else:
                entity_type_names_str = ', '.join(entity_types)
        else:
            entity_type_names_str = 'sensitive data' if lang != 'zh' else '敏感数据'

        return template.replace('{entity_type_names}', entity_type_names_str)

    async def _ensure_cache_fresh(self):
        """Ensure cache is fresh"""
        current_time = time.time()
        if current_time - self._cache_timestamp > self._cache_ttl:
            async with self._lock:
                if current_time - self._cache_timestamp > self._cache_ttl:
                    await self._refresh_cache()

    async def _refresh_cache(self):
        """Refresh knowledge base cache"""
        try:
            db = get_db_session()
            try:
                # Load all enabled knowledge bases
                knowledge_bases = db.query(KnowledgeBase).filter_by(is_active=True).all()
                new_kb_cache: Dict[str, Dict[str, List[int]]] = {}
                global_kb_cache: Dict[str, List[int]] = {}

                for kb in knowledge_bases:
                    app_key = str(kb.application_id) if kb.application_id else None
                    if not app_key:
                        continue

                    # Build cache key
                    cache_key = None
                    if kb.scanner_type and kb.scanner_identifier:
                        cache_key = f"{kb.scanner_type}:{kb.scanner_identifier}"
                    elif kb.category:
                        cache_key = kb.category

                    if not cache_key:
                        continue

                    # Application's own KB
                    if app_key not in new_kb_cache:
                        new_kb_cache[app_key] = {}
                    if cache_key not in new_kb_cache[app_key]:
                        new_kb_cache[app_key][cache_key] = []
                    new_kb_cache[app_key][cache_key].append(kb.id)

                    # Global KB
                    if kb.is_global:
                        if cache_key not in global_kb_cache:
                            global_kb_cache[cache_key] = []
                        global_kb_cache[cache_key].append(kb.id)

                self._global_knowledge_base_cache = global_kb_cache

                # Load tenant disabled KB records
                tenant_disabled_kb_cache: Dict[str, set] = {}
                disabled_records = db.query(TenantKnowledgeBaseDisable).all()
                for record in disabled_records:
                    tenant_key = str(record.tenant_id)
                    if tenant_key not in tenant_disabled_kb_cache:
                        tenant_disabled_kb_cache[tenant_key] = set()
                    tenant_disabled_kb_cache[tenant_key].add(record.kb_id)

                self._tenant_disabled_kb_cache = tenant_disabled_kb_cache
                self._knowledge_base_cache = new_kb_cache
                self._cache_timestamp = time.time()

                kb_count = sum(
                    sum(len(kb_ids) for kb_ids in app_kbs.values())
                    for app_kbs in new_kb_cache.values()
                )
                logger.debug(f"KB cache refreshed: {kb_count} knowledge bases")

            finally:
                db.close()

        except Exception as e:
            logger.error(f"Failed to refresh KB cache: {e}", exc_info=True)

    async def invalidate_cache(self):
        """Invalidate cache"""
        async with self._lock:
            self._cache_timestamp = 0
            logger.info("Enhanced template cache invalidated")

    def get_cache_info(self) -> dict:
        """Get cache statistics"""
        kb_count = sum(
            sum(len(kb_ids) for kb_ids in app_kbs.values())
            for app_kbs in self._knowledge_base_cache.values()
        )
        global_kb_count = sum(len(kb_ids) for kb_ids in self._global_knowledge_base_cache.values())

        return {
            "applications": len(self._knowledge_base_cache),
            "templates": 0,  # Not used in new design
            "knowledge_bases": kb_count,
            "global_knowledge_bases": global_kb_count,
            "last_refresh": self._cache_timestamp,
            "cache_age_seconds": time.time() - self._cache_timestamp if self._cache_timestamp > 0 else 0
        }


# Global instance
enhanced_template_service = EnhancedTemplateService(cache_ttl=600)
