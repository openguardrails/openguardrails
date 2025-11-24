import uuid
import json
from typing import List, Dict, Tuple, Optional, Union
from datetime import datetime, timezone
from sqlalchemy.orm import Session
from database.models import DetectionResult, ResponseTemplate, Application
from services.model_service import model_service
from services.keyword_service import KeywordService
from services.keyword_cache import keyword_cache
from services.enhanced_template_service import enhanced_template_service
from services.async_logger import async_detection_logger
from services.risk_config_service import RiskConfigService
from services.data_security_service import DataSecurityService
from services.billing_service import billing_service
from models.requests import GuardrailRequest, Message
from models.responses import GuardrailResponse, GuardrailResult, ComplianceResult, SecurityResult, DataSecurityResult
from utils.logger import setup_logger
from utils.i18n_loader import get_translation

logger = setup_logger()

# Risk level mapping (21 risk types)
RISK_LEVEL_MAPPING = {
    'S2': 'high_risk',   # Sensitive Political Topics
    'S3': 'high_risk',   # Insult to National Symbols or Leaders
    'S5': 'high_risk',   # Violent Crime
    'S9': 'high_risk',   # Prompt Attacks
    'S15': 'high_risk',  # Weapons of Mass Destruction
    'S17': 'high_risk',  # Sexual Crimes
    'S4': 'medium_risk', # Harm to Minors
    'S6': 'medium_risk', # Non-Violent Crime
    'S7': 'medium_risk', # Pornography
    'S16': 'medium_risk',# Self-Harm
    'S1': 'low_risk',    # General Political Topics
    'S8': 'low_risk',    # Hate & Discrimination
    'S10': 'low_risk',   # Profanity
    'S11': 'low_risk',   # Privacy Invasion
    'S12': 'low_risk',   # Commercial Violations
    'S13': 'low_risk',   # Intellectual Property Infringement
    'S14': 'low_risk',   # Harassment
    'S18': 'low_risk',   # Threats
    'S19': 'low_risk',   # Professional Financial Advice
    'S20': 'low_risk',   # Professional Medical Advice
    'S21': 'low_risk',   # Professional Legal Advice
}

# Category name mapping (21 risk types)
CATEGORY_NAMES = {
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

class GuardrailService:
    """Guardrail Detection Service"""

    def __init__(self, db: Session):
        self.db = db
        self.keyword_service = KeywordService(db)
        self.risk_config_service = RiskConfigService(db)

    async def check_guardrails(
        self,
        request: GuardrailRequest,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
        tenant_id: Optional[str] = None,  # tenant_id for backward compatibility
        application_id: Optional[str] = None  # application_id for new multi-application support
    ) -> GuardrailResponse:
        """Execute guardrail detection"""

        # Generate request ID
        request_id = f"guardrails-{uuid.uuid4().hex}"

        # If application_id is not provided but tenant_id is, find default application
        if not application_id and tenant_id:
            try:
                tenant_uuid = uuid.UUID(str(tenant_id))
                default_app = self.db.query(Application).filter(
                    Application.tenant_id == tenant_uuid,
                    Application.is_active == True
                ).order_by(Application.created_at.asc()).first()
                
                if default_app:
                    application_id = str(default_app.id)
                    logger.debug(f"Using default application {application_id} for tenant {tenant_id}")
                else:
                    logger.warning(f"No active application found for tenant {tenant_id}")
            except (ValueError, Exception) as e:
                logger.warning(f"Failed to find default application for tenant {tenant_id}: {e}")

        # Extract user content
        user_content = self._extract_user_content(request.messages)
        try:
            # 1. Blacklist/whitelist pre-check (using high-performance memory cache, application-scoped)
            blacklist_hit, blacklist_name, blacklist_keywords = await keyword_cache.check_blacklist(
                user_content, tenant_id=tenant_id, application_id=application_id
            )
            if blacklist_hit:
                return await self._handle_blacklist_hit(
                    request_id, user_content, blacklist_name, blacklist_keywords,
                    ip_address, user_agent, tenant_id, application_id
                )

            whitelist_hit, whitelist_name, whitelist_keywords = await keyword_cache.check_whitelist(
                user_content, tenant_id=tenant_id, application_id=application_id
            )
            if whitelist_hit:
                return await self._handle_whitelist_hit(
                    request_id, user_content, whitelist_name, whitelist_keywords,
                    ip_address, user_agent, tenant_id, application_id
                )

            # 2. Data leak detection for INPUT (before sending to model)
            # Note: Data leak detection logic differs from compliance/security detection
            # - Input detection: Detects user input for sensitive data, returns desensitized text
            #   The desensitized text should be the suggested answer for "replace" action
            # - Output detection: Detects LLM output for sensitive data, returns desensitized text
            #   The desensitized text should be the suggested answer for "replace" action
            data_security_service = DataSecurityService(self.db)
            data_result = DataSecurityResult(risk_level="no_risk", categories=[])
            anonymized_text = None

            # Check if this is input or output detection
            has_assistant_message = any(msg.role == 'assistant' for msg in request.messages)

            if not has_assistant_message:
                # This is INPUT detection - check user input for sensitive data before sending to model
                logger.info(f"Starting input data leak detection for tenant {tenant_id}")
                data_detection_result = await data_security_service.detect_sensitive_data(
                    text=user_content,
                    tenant_id=tenant_id,
                    direction='input'
                )
                logger.info(f"Input data leak detection result: {data_detection_result}")

                # Construct data security result
                data_result = DataSecurityResult(
                    risk_level=data_detection_result.get('risk_level', 'no_risk'),
                    categories=data_detection_result.get('categories', [])
                )

                # If sensitive data found in input, store the desensitized text
                # This will be used as the suggested answer to send to upstream LLM
                if data_result.risk_level != 'no_risk':
                    anonymized_text = data_detection_result.get('anonymized_text')

            # 3. Model detection (only if not output detection)
            # Convert Message objects to dict format and process images
            from utils.image_utils import image_utils

            messages_dict = []
            has_image = False
            saved_image_paths = []

            for msg in request.messages:
                content = msg.content
                if isinstance(content, str):
                    messages_dict.append({"role": msg.role, "content": content})
                elif isinstance(content, list):
                    # Multimodal content
                    content_parts = []
                    for part in content:
                        if hasattr(part, 'type'):
                            if part.type == 'text' and hasattr(part, 'text'):
                                content_parts.append({"type": "text", "text": part.text})
                            elif part.type == 'image_url' and hasattr(part, 'image_url'):
                                has_image = True
                                original_url = part.image_url.url
                                # Process image: save and get path
                                processed_url, saved_path = image_utils.process_image_url(original_url, tenant_id)
                                if saved_path:
                                    saved_image_paths.append(saved_path)
                                content_parts.append({"type": "image_url", "image_url": {"url": processed_url}})
                    messages_dict.append({"role": msg.role, "content": content_parts})
                else:
                    messages_dict.append({"role": msg.role, "content": content})

            # Check subscription for image detection if images are present
            if has_image and tenant_id:
                subscription = billing_service.get_subscription(tenant_id, self.db)
                if not subscription:
                    logger.warning(f"Image detection attempted without subscription for tenant {tenant_id}")
                    # Create error that will be caught by the calling endpoint
                    from fastapi import HTTPException
                    raise HTTPException(status_code=403, detail="Subscription not found. Please contact support to enable image detection.")

                if subscription.subscription_type != 'subscribed':
                    logger.warning(f"Image detection attempted by free user for tenant {tenant_id}")
                    # Create error that will be caught by the calling endpoint
                    from fastapi import HTTPException
                    raise HTTPException(status_code=403, detail="Image detection is only available for subscribed users. Please upgrade your plan to access this feature.")

            # 4. Execute scanner-based detection (new system) or fall back to legacy detection
            matched_scanners = []  # Initialize for answer matching
            
            if application_id:
                # Use new scanner detection system
                try:
                    from services.scanner_detection_service import ScannerDetectionService
                    from uuid import UUID

                    logger.info(f"Using scanner detection for application {application_id}")

                    # Determine scan type based on message structure
                    scan_type = 'response' if has_assistant_message else 'prompt'

                    # Execute scanner detection
                    scanner_service = ScannerDetectionService(self.db)
                    detection_result = await scanner_service.execute_detection(
                        content=user_content,
                        application_id=UUID(application_id),
                        tenant_id=tenant_id,
                        scan_type=scan_type,
                        messages_for_genai=messages_dict  # Full context for GenAI scanners
                    )

                    # Convert scanner detection result to compliance/security results
                    if detection_result.overall_risk_level == "no_risk":
                        compliance_result = ComplianceResult(risk_level="no_risk", categories=[])
                        security_result = SecurityResult(risk_level="no_risk", categories=[])
                    else:
                        # Determine risk levels for compliance and security
                        compliance_risk = detection_result.overall_risk_level if detection_result.compliance_categories else "no_risk"
                        security_risk = detection_result.overall_risk_level if detection_result.security_categories else "no_risk"

                        compliance_result = ComplianceResult(
                            risk_level=compliance_risk,
                            categories=detection_result.compliance_categories
                        )
                        security_result = SecurityResult(
                            risk_level=security_risk,
                            categories=detection_result.security_categories
                        )

                    # Store matched scanners for answer matching
                    matched_scanners = detection_result.matched_scanners
                    logger.info(f"Scanner detection complete: risk={detection_result.overall_risk_level}, matched_scanners={[s.scanner_tag for s in matched_scanners]}")

                except Exception as scanner_error:
                    logger.error(f"Scanner detection failed, falling back to legacy detection: {scanner_error}")
                    # Fall back to legacy detection
                    use_vl_model = has_image
                    model_response, _ = await model_service.check_messages_with_sensitivity(messages_dict, use_vl_model=use_vl_model)
                    compliance_result, security_result = self._parse_model_response(model_response, tenant_id)
            else:
                # No application_id: use legacy detection for backward compatibility
                logger.warning(f"No application_id provided, using legacy detection for tenant {tenant_id}")
                use_vl_model = has_image
                model_response, _ = await model_service.check_messages_with_sensitivity(messages_dict, use_vl_model=use_vl_model)
                compliance_result, security_result = self._parse_model_response(model_response, tenant_id)

            # 5. Data leak detection for OUTPUT (after getting LLM response)
            if has_assistant_message:
                # This is OUTPUT detection - check assistant's response for sensitive data
                detection_content = self._extract_assistant_content(request.messages)

                logger.info(f"Starting output data leak detection for tenant {tenant_id}")
                data_detection_result = await data_security_service.detect_sensitive_data(
                    text=detection_content,
                    tenant_id=tenant_id,
                    direction='output'
                )
                logger.info(f"Output data leak detection result: {data_detection_result}")

                # Construct data security result
                data_result = DataSecurityResult(
                    risk_level=data_detection_result.get('risk_level', 'no_risk'),
                    categories=data_detection_result.get('categories', [])
                )

                # If sensitive data found in output, store the desensitized text
                # This will be used as the suggested answer to return to user
                if data_result.risk_level != 'no_risk':
                    anonymized_text = data_detection_result.get('anonymized_text')

            # 6. Determine suggested action and answer
            overall_risk_level, suggest_action, suggest_answer = await self._determine_action(
                compliance_result, security_result, tenant_id=tenant_id, application_id=application_id, 
                user_query=user_content, data_result=data_result, anonymized_text=anonymized_text,
                matched_scanners=matched_scanners
            )

            # 7. Asynchronously log detection results
            await self._log_detection_result(
                request_id, user_content, compliance_result, security_result,
                suggest_action, suggest_answer, model_response,
                ip_address, user_agent, tenant_id,
                has_image=has_image, image_count=len(saved_image_paths), image_paths=saved_image_paths
            )

            # 8. Construct response
            result = GuardrailResult(
                compliance=compliance_result,
                security=security_result,
                data=data_result
            )

            return GuardrailResponse(
                id=request_id,
                result=result,
                overall_risk_level=overall_risk_level,
                suggest_action=suggest_action,
                suggest_answer=suggest_answer,
            )

        except Exception as e:
            logger.error(f"Guardrail check error: {e}")
            # Return safe default response on error
            return await self._handle_error(request_id, user_content, str(e), tenant_id)
    
    def _extract_assistant_content(self, messages: List[Message]) -> str:
        """Extract assistant message content for output detection"""
        for msg in reversed(messages):  # Get the last assistant message
            if msg.role == 'assistant':
                content = msg.content
                if isinstance(content, str):
                    return content
                elif isinstance(content, list):
                    # For multimodal content, only extract text part
                    text_parts = []
                    for part in content:
                        if hasattr(part, 'type') and part.type == 'text' and hasattr(part, 'text'):
                            text_parts.append(part.text)
                    return ' '.join(text_parts) if text_parts else ""
                else:
                    return str(content)
        return ""

    def _extract_user_content(self, messages: List[Message]) -> str:
        """Extract complete conversation content"""
        if len(messages) == 1 and messages[0].role == 'user':
            # Single user message (prompt detection)
            content = messages[0].content
            if isinstance(content, str):
                return content
            elif isinstance(content, list):
                # For multimodal content, only extract text part for log
                text_parts = []
                for part in content:
                    if hasattr(part, 'type') and part.type == 'text' and hasattr(part, 'text'):
                        text_parts.append(part.text)
                    elif hasattr(part, 'type') and part.type == 'image_url':
                        text_parts.append("[Image]")
                return ' '.join(text_parts) if text_parts else "[Multimodal content]"
            else:
                return str(content)
        else:
            # Multiple messages (conversation detection), save full conversation
            conversation_parts = []
            for msg in messages:
                role_label = "User" if msg.role == "user" else "Assistant" if msg.role == "assistant" else msg.role
                content = msg.content
                if isinstance(content, str):
                    conversation_parts.append(f"[{role_label}]: {content}")
                elif isinstance(content, list):
                    # For multimodal content, only extract text part
                    text_parts = []
                    for part in content:
                        if hasattr(part, 'type') and part.type == 'text' and hasattr(part, 'text'):
                            text_parts.append(part.text)
                        elif hasattr(part, 'type') and part.type == 'image_url':
                            text_parts.append("[Image]")
                    content_str = ' '.join(text_parts) if text_parts else "[Multimodal content]"
                    conversation_parts.append(f"[{role_label}]: {content_str}")
                else:
                    conversation_parts.append(f"[{role_label}]: {content}")
            return '\n'.join(conversation_parts)
    
    def _parse_model_response(self, response: str, tenant_id: Optional[str] = None) -> Tuple[ComplianceResult, SecurityResult]:
        """Parse model response and apply risk type filtering

        Supports multiple labels separated by commas (e.g., "unsafe\nS2,S5,S7")
        Note: Parameter name kept as tenant_id for backward compatibility
        """
        response = response.strip()

        if response == "safe":
            return (
                ComplianceResult(risk_level="no_risk", categories=[]),
                SecurityResult(risk_level="no_risk", categories=[])
            )

        if response.startswith("unsafe\n"):
            categories_line = response.split('\n')[1] if '\n' in response else ""
            # Split by comma to support multiple labels
            categories = [cat.strip() for cat in categories_line.split(',') if cat.strip()]

            if not categories:
                return (
                    ComplianceResult(risk_level="no_risk", categories=[]),
                    SecurityResult(risk_level="no_risk", categories=[])
                )

            # Filter out disabled risk types, but only if ALL labels are disabled
            enabled_categories = []
            for category in categories:
                if not tenant_id or self.risk_config_service.is_risk_type_enabled(tenant_id=tenant_id, risk_type=category):
                    enabled_categories.append(category)

            # If all categories are disabled, treat as safe
            if not enabled_categories:
                logger.info(f"All risk types {categories} are disabled for tenant {tenant_id}, treating as safe")
                return (
                    ComplianceResult(risk_level="no_risk", categories=[]),
                    SecurityResult(risk_level="no_risk", categories=[])
                )

            # Determine highest risk level from enabled categories
            highest_risk_level = "no_risk"
            risk_priority = {"no_risk": 0, "low_risk": 1, "medium_risk": 2, "high_risk": 3}

            for category in enabled_categories:
                risk_level = RISK_LEVEL_MAPPING.get(category, "medium_risk")
                if risk_priority[risk_level] > risk_priority[highest_risk_level]:
                    highest_risk_level = risk_level

            # Separate security (S9) from compliance categories
            security_categories = []
            compliance_categories = []

            for category in enabled_categories:
                category_name = CATEGORY_NAMES.get(category, category)
                if category == "S9":  # Prompt Attacks
                    security_categories.append(category_name)
                else:
                    compliance_categories.append(category_name)

            # Determine risk levels for each type
            security_risk_level = "no_risk"
            compliance_risk_level = "no_risk"

            if security_categories:
                # Get highest risk level for security categories
                for category in enabled_categories:
                    if category == "S9":
                        risk_level = RISK_LEVEL_MAPPING.get(category, "medium_risk")
                        if risk_priority[risk_level] > risk_priority[security_risk_level]:
                            security_risk_level = risk_level

            if compliance_categories:
                # Get highest risk level for compliance categories
                for category in enabled_categories:
                    if category != "S9":
                        risk_level = RISK_LEVEL_MAPPING.get(category, "medium_risk")
                        if risk_priority[risk_level] > risk_priority[compliance_risk_level]:
                            compliance_risk_level = risk_level

            return (
                ComplianceResult(risk_level=compliance_risk_level, categories=compliance_categories),
                SecurityResult(risk_level=security_risk_level, categories=security_categories)
            )

        # Default return safe
        return (
            ComplianceResult(risk_level="no_risk", categories=[]),
            SecurityResult(risk_level="no_risk", categories=[])
        )
    
    async def _determine_action(
        self,
        compliance_result: ComplianceResult,
        security_result: SecurityResult,
        tenant_id: Optional[str] = None,  # tenant_id for backward compatibility
        application_id: Optional[str] = None,  # application_id for multi-application support
        user_query: Optional[str] = None,
        data_result: Optional[DataSecurityResult] = None,
        anonymized_text: Optional[str] = None,  # De-sensitized text for data leak scenarios
        matched_scanners: Optional[list] = None  # Matched scanners from scanner detection
    ) -> Tuple[str, str, Optional[str]]:
        """Determine suggested action and answer"""

        # Define risk level priority (higher value = higher priority)
        risk_priority = {
            "no_risk": 0,
            "low_risk": 1,
            "medium_risk": 2,
            "high_risk": 3
        }

        # Get highest risk level (including data leak detection)
        compliance_priority = risk_priority.get(compliance_result.risk_level, 0)
        security_priority = risk_priority.get(security_result.risk_level, 0)
        data_priority = risk_priority.get(data_result.risk_level, 0) if data_result else 0

        # Get the risk level corresponding to the highest priority
        max_priority = max(compliance_priority, security_priority, data_priority)
        overall_risk_level = next(level for level, priority in risk_priority.items() if priority == max_priority)

        # Collect all risk categories
        risk_categories = []
        if compliance_result.risk_level != "no_risk":
            risk_categories.extend(compliance_result.categories)
        if security_result.risk_level != "no_risk":
            risk_categories.extend(security_result.categories)
        if data_result and data_result.risk_level != "no_risk":
            risk_categories.extend(data_result.categories)

        # Determine action based on overall risk level
        if overall_risk_level == "no_risk":
            return overall_risk_level, "pass", None
        elif overall_risk_level == "high_risk":
            suggest_answer = await self._get_suggest_answer(risk_categories, tenant_id, application_id, user_query, matched_scanners)
            return overall_risk_level, "reject", suggest_answer
        elif overall_risk_level == "medium_risk":
            # For data leak scenarios with replace action, use anonymized text if available
            if anonymized_text and data_result and data_result.risk_level != "no_risk":
                return overall_risk_level, "replace", anonymized_text
            suggest_answer = await self._get_suggest_answer(risk_categories, tenant_id, application_id, user_query, matched_scanners)
            return overall_risk_level, "replace", suggest_answer
        else:  # low_risk
            # For data leak scenarios with replace action, use anonymized text if available
            if anonymized_text and data_result and data_result.risk_level != "no_risk":
                return overall_risk_level, "replace", anonymized_text
            suggest_answer = await self._get_suggest_answer(risk_categories, tenant_id, application_id, user_query, matched_scanners)
            return overall_risk_level, "replace", suggest_answer
    
    async def _get_suggest_answer(self, categories: List[str], tenant_id: Optional[str] = None, application_id: Optional[str] = None, user_query: Optional[str] = None, matched_scanners: Optional[list] = None) -> str:
        """Get suggested answer (using enhanced template service, supports knowledge base search)

        Args:
            categories: Risk categories (scanner names, not tags)
            tenant_id: DEPRECATED - kept for backward compatibility
            application_id: Application ID for multi-application support
            user_query: User query for knowledge base search
            matched_scanners: Matched scanners from scanner detection (optional)
        """
        from database.models import Tenant

        # Get user's language preference
        user_language = None
        if tenant_id:
            try:
                tenant = self.db.query(Tenant).filter(Tenant.id == tenant_id).first()
                if tenant:
                    user_language = tenant.language
            except Exception as e:
                logger.warning(f"Failed to get user language for tenant {tenant_id}: {e}")

        # Extract scanner information from matched scanners (use highest risk scanner)
        scanner_type = None
        scanner_identifier = None
        scanner_name = None
        
        if matched_scanners and len(matched_scanners) > 0:
            # Use the first matched scanner (highest priority)
            first_scanner = matched_scanners[0]
            scanner_type = "official_scanner"  # All scanners in new system are official_scanner type
            scanner_identifier = first_scanner.scanner_tag  # Use scanner tag as identifier (e.g., S8, S100)
            scanner_name = first_scanner.scanner_name  # Human-readable name for template variable
            logger.info(f"Using scanner info for answer matching: type={scanner_type}, identifier={scanner_identifier}, name={scanner_name}")
        elif categories:
            # Fallback: use first category as scanner_name
            scanner_name = categories[0]
            logger.debug(f"No matched_scanners provided, using first category as scanner_name: {scanner_name}")

        return await enhanced_template_service.get_suggest_answer(
            categories,
            tenant_id=tenant_id,
            application_id=application_id,
            user_query=user_query,
            user_language=user_language,
            scanner_type=scanner_type,
            scanner_identifier=scanner_identifier,
            scanner_name=scanner_name
        )
    
    async def _handle_blacklist_hit(
        self, request_id: str, content: str, list_name: str,
        keywords: List[str], ip_address: Optional[str], user_agent: Optional[str],
        tenant_id: Optional[str] = None,
        application_id: Optional[str] = None
    ) -> GuardrailResponse:
        """Handle blacklist hit"""

        # Get user's language preference
        user_language = 'en'  # Default to English
        if tenant_id:
            try:
                from database.models import Tenant
                tenant = self.db.query(Tenant).filter(Tenant.id == tenant_id).first()
                if tenant and tenant.language:
                    user_language = tenant.language
            except Exception as e:
                logger.warning(f"Failed to get user language for tenant {tenant_id}: {e}")

        # Use enhanced template service to get blacklist response (supports custom templates and knowledge base)
        from services.enhanced_template_service import enhanced_template_service
        suggest_answer = await enhanced_template_service.get_suggest_answer(
            categories=[],  # Blacklist doesn't use legacy categories
            tenant_id=tenant_id,
            application_id=application_id,
            user_query=content,  # User's original input for KB search
            user_language=user_language,
            scanner_type='blacklist',  # Scanner type
            scanner_identifier=list_name,  # Blacklist name
            scanner_name=list_name  # For {scanner_name} variable replacement
        )

        # Asynchronously log to database
        detection_data = {
            "request_id": request_id,
            "tenant_id": tenant_id,
            "application_id": application_id,
            "content": content,
            "suggest_action": "reject",
            "suggest_answer": suggest_answer,
            "hit_keywords": json.dumps(keywords),
            "model_response": "blacklist_hit",
            "ip_address": ip_address,
            "user_agent": user_agent,
            "security_risk_level": "no_risk",
            "security_categories": [],
            "compliance_risk_level": "high_risk",
            "compliance_categories": [list_name],
            "created_at": datetime.now(timezone.utc).isoformat()
        }
        await async_detection_logger.log_detection(detection_data)

        return GuardrailResponse(
            id=request_id,
            result=GuardrailResult(
                compliance=ComplianceResult(risk_level="high_risk", categories=[list_name]),
                security=SecurityResult(risk_level="no_risk", categories=[]),
                data=DataSecurityResult(risk_level="no_risk", categories=[])
            ),
            overall_risk_level="high_risk",
            suggest_action="reject",
            suggest_answer=suggest_answer
        )
    
    async def _handle_whitelist_hit(
        self, request_id: str, content: str, list_name: str,
        keywords: List[str], ip_address: Optional[str], user_agent: Optional[str],
        tenant_id: Optional[str] = None,
        application_id: Optional[str] = None
    ) -> GuardrailResponse:
        """Handle whitelist hit"""

        # Asynchronously record to log
        detection_data = {
            "request_id": request_id,
            "tenant_id": tenant_id,
            "application_id": application_id,
            "content": content,
            "suggest_action": "pass",
            "suggest_answer": None,
            "hit_keywords": json.dumps(keywords),
            "model_response": "whitelist_hit",
            "ip_address": ip_address,
            "user_agent": user_agent,
            "security_risk_level": "no_risk",
            "security_categories": [],
            "compliance_risk_level": "no_risk",
            "compliance_categories": [],
            "created_at": datetime.now(timezone.utc).isoformat()
        }
        await async_detection_logger.log_detection(detection_data)
        
        return GuardrailResponse(
            id=request_id,
            result=GuardrailResult(
                compliance=ComplianceResult(risk_level="no_risk", categories=[]),
                security=SecurityResult(risk_level="no_risk", categories=[]),
                data=DataSecurityResult(risk_level="no_risk", categories=[])
            ),
            overall_risk_level="no_risk",
            suggest_action="pass",
            suggest_answer=None
        )
    
    async def _log_detection_result(
        self, request_id: str, content: str, compliance_result: ComplianceResult,
        security_result: SecurityResult, suggest_action: str, suggest_answer: Optional[str],
        model_response: str, ip_address: Optional[str], user_agent: Optional[str],
        tenant_id: Optional[str] = None, has_image: bool = False,
        image_count: int = 0, image_paths: List[str] = None
    ):
        """Asynchronously record detection results to log"""

        # Clean NUL characters in content
        from utils.validators import clean_null_characters

        detection_data = {
            "request_id": request_id,
            "tenant_id": tenant_id,
            "content": clean_null_characters(content) if content else content,
            "suggest_action": suggest_action,
            "suggest_answer": clean_null_characters(suggest_answer) if suggest_answer else suggest_answer,
            "model_response": clean_null_characters(model_response) if model_response else model_response,
            "ip_address": ip_address,
            "user_agent": clean_null_characters(user_agent) if user_agent else user_agent,
            "security_risk_level": security_result.risk_level,
            "security_categories": security_result.categories,
            "compliance_risk_level": compliance_result.risk_level,
            "compliance_categories": compliance_result.categories,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "hit_keywords": None,  # Only hit keywords for blacklist/whitelist
            "has_image": has_image,
            "image_count": image_count,
            "image_paths": image_paths or []
        }

        # Only write log file, not write database (managed by admin service's log processor)
        await async_detection_logger.log_detection(detection_data)
    
    async def _handle_error(self, request_id: str, content: str, error: str, tenant_id: Optional[int] = None) -> GuardrailResponse:
        """Handle error situation"""
        
        # Asynchronously record error detection results
        detection_data = {
            "request_id": request_id,
            "tenant_id": tenant_id,
            "content": content,
            "suggest_action": "pass",
            "suggest_answer": None,
            "model_response": f"error: {error}",
            "security_risk_level": "no_risk",
            "security_categories": [],
            "compliance_risk_level": "no_risk",
            "compliance_categories": [],
            "created_at": datetime.now(timezone.utc).isoformat(),
            "hit_keywords": None,
            "ip_address": None,
            "user_agent": None
        }
        await async_detection_logger.log_detection(detection_data)
        
        return GuardrailResponse(
            id=request_id,
            result=GuardrailResult(
                compliance=ComplianceResult(risk_level="no_risk", categories=[]),
                security=SecurityResult(risk_level="no_risk", categories=[]),
                data=DataSecurityResult(risk_level="no_risk", categories=[])
            ),
            overall_risk_level="no_risk",  # When system error, treat as no risk
            suggest_action="pass",
            suggest_answer=None
        )