import uuid
import json
from typing import List, Dict, Tuple, Optional, Union, Any
from datetime import datetime, timezone
from sqlalchemy.orm import Session
from services.model_service import model_service
from services.keyword_service import KeywordService
from services.keyword_cache import keyword_cache
from services.template_cache import template_cache
from services.async_logger import async_detection_logger
from services.risk_config_cache import risk_config_cache
from models.requests import GuardrailRequest, Message
from models.responses import GuardrailResponse, GuardrailResult, ComplianceResult, SecurityResult, DataSecurityResult
from utils.logger import setup_logger
from utils.message_truncator import MessageTruncator
from utils.i18n_loader import get_translation
from database.connection import get_db_session
from database.models import Application

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

class DetectionGuardrailService:
    """Detection service专用护栏服务 - 只写日志，不写数据库"""
    
    def __init__(self):
        # No database connection, only use cache
        pass
    
    async def detect_content(
        self,
        content: str,
        tenant_id: str,
        request_id: str,
        model_sensitivity_trigger_level: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Simplified detection method for proxy service
        Wrap single content text as GuardrailRequest and call check_guardrails
        """
        from models.requests import GuardrailRequest, Message
        
        # Wrap text content as message format
        message = Message(role="user", content=content)
        request = GuardrailRequest(model="detection", messages=[message])

        # Call full detection method
        result = await self.check_guardrails(
            request=request,
            tenant_id=tenant_id,
            model_sensitivity_trigger_level=model_sensitivity_trigger_level
        )
        
        # Return format compatible with proxy API
        return {
            "request_id": result.id,
            "suggest_action": result.suggest_action,
            "suggest_answer": result.suggest_answer,
            "overall_risk_level": result.overall_risk_level,
            "compliance_result": result.result.compliance.__dict__ if result.result.compliance else None,
            "security_result": result.result.security.__dict__ if result.result.security else None
        }

    async def detect_messages(
        self,
        messages: List[Dict[str, str]],
        tenant_id: str,
        request_id: str,
        model_sensitivity_trigger_level: Optional[str] = None,
        application_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Context-aware detection method - support messages structure for question-answer pairs
        Directly use messages list for detection, support multi-turn conversation context
        """
        from models.requests import GuardrailRequest, Message

        # Convert dictionary format messages to Message objects
        message_objects = []
        for msg in messages:
            message_objects.append(Message(role=msg["role"], content=msg["content"]))

        request = GuardrailRequest(model="detection", messages=message_objects)

        # Call full detection method
        result = await self.check_guardrails(
            request=request,
            tenant_id=tenant_id,
            application_id=application_id,
            model_sensitivity_trigger_level=model_sensitivity_trigger_level
        )
        
        # Return format compatible with proxy API
        return {
            "request_id": result.id,
            "suggest_action": result.suggest_action,
            "suggest_answer": result.suggest_answer,
            "overall_risk_level": result.overall_risk_level,
            "compliance_result": result.result.compliance.__dict__ if result.result.compliance else None,
            "security_result": result.result.security.__dict__ if result.result.security else None,
            "data_result": result.result.data.__dict__ if result.result.data else None
        }
    
    async def check_guardrails(
        self,
        request: GuardrailRequest,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
        tenant_id: Optional[str] = None,
        application_id: Optional[str] = None,
        model_sensitivity_trigger_level: Optional[str] = None
    ) -> GuardrailResponse:
        """Execute guardrail detection (only write log file)"""
        
        # Generate request ID
        request_id = f"guardrails-{uuid.uuid4().hex}"
        
        # First truncate messages to meet maximum context length requirements
        truncated_messages = MessageTruncator.truncate_messages(request.messages)
        
        # If no messages after truncation, return error
        if not truncated_messages:
            logger.warning(f"No valid messages after truncation for request {request_id}")
            return await self._handle_error(request_id, "", "No valid messages after truncation", tenant_id, application_id)
        
        # If application_id is not provided but tenant_id is, find default application
        if not application_id and tenant_id:
            try:
                db = get_db_session()
                try:
                    tenant_uuid = uuid.UUID(str(tenant_id))
                    default_app = db.query(Application).filter(
                        Application.tenant_id == tenant_uuid,
                        Application.is_active == True
                    ).order_by(Application.created_at.asc()).first()
                    
                    if default_app:
                        application_id = str(default_app.id)
                        logger.debug(f"Using default application {application_id} for tenant {tenant_id}")
                    else:
                        logger.warning(f"No active application found for tenant {tenant_id}")
                finally:
                    db.close()
            except (ValueError, Exception) as e:
                logger.warning(f"Failed to find default application for tenant {tenant_id}: {e}")

        # Extract user content (using truncated messages)
        user_content = self._extract_user_content(truncated_messages)
        
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
            
            # 2. Data security detection
            # Determine detection direction based on message structure
            # If the last message is assistant (output), detect output
            # Otherwise detect input
            detection_direction = "output" if truncated_messages and truncated_messages[-1].role == "assistant" else "input"
            # Extract appropriate content for data leak detection
            content_for_data_detection = self._extract_content_for_data_detection(truncated_messages, detection_direction)
            data_result, data_anonymized_text = await self._check_data_security(content_for_data_detection, tenant_id, direction=detection_direction, application_id=application_id)

            # 3. Model detection (using truncated messages, get sensitivity)
            # Convert messages to dictionary format, support multi-modal
            from utils.image_utils import image_utils

            messages_dict = []
            has_image = False
            saved_image_paths = []  # Record saved image paths

            for msg in truncated_messages:
                content = msg.content
                if isinstance(content, str):
                    messages_dict.append({"role": msg.role, "content": content})
                elif isinstance(content, list):
                    # Multi-modal content
                    content_parts = []
                    for part in content:
                        if hasattr(part, 'type'):
                            if part.type == 'text' and hasattr(part, 'text'):
                                content_parts.append({"type": "text", "text": part.text})
                            elif part.type == 'image_url' and hasattr(part, 'image_url'):
                                has_image = True
                                # Process image URL (support base64, file://, http(s)://)
                                original_url = part.image_url.url
                                processed_url, saved_path = image_utils.process_image_url(original_url, tenant_id)

                                # If saved image, record path
                                if saved_path:
                                    saved_image_paths.append(saved_path)

                                # Pass processed URL to model (base64 keep unchanged, directly send to model)
                                content_parts.append({"type": "image_url", "image_url": {"url": processed_url}})
                    messages_dict.append({"role": msg.role, "content": content_parts})

            # 4. Execute scanner-based detection (new system) or fall back to legacy detection
            matched_scanner_tags = []  # Initialize for logging

            if application_id:
                # Use new scanner detection system
                try:
                    from services.scanner_detection_service import ScannerDetectionService
                    from uuid import UUID

                    # Create scanner detection service with database session
                    scanner_db = get_db_session()
                    try:
                        scanner_service = ScannerDetectionService(scanner_db)

                        # Determine scan type based on message structure
                        # If last message is assistant, this is response detection
                        scan_type = 'response' if truncated_messages and truncated_messages[-1].role == 'assistant' else 'prompt'

                        logger.info(f"Using scanner detection for application {application_id}, scan_type={scan_type}")

                        # Execute scanner detection
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

                        # Store matched scanner tags for logging
                        matched_scanner_tags = detection_result.matched_scanner_tags
                        matched_scanners = detection_result.matched_scanners  # Keep full scanner info for answer matching
                        sensitivity_score = None  # Scanner system doesn't use single sensitivity score
                        model_response = "scanner_detection"  # Indicate scanner-based detection was used

                        logger.info(f"Scanner detection complete: risk={detection_result.overall_risk_level}, matched_tags={matched_scanner_tags}")

                    finally:
                        scanner_db.close()

                except Exception as scanner_error:
                    logger.error(f"Scanner detection failed, falling back to legacy detection: {scanner_error}")
                    # Fall back to legacy detection
                    matched_scanners = []  # No scanner info for legacy detection
                    model_response, sensitivity_score = await model_service.check_messages_with_sensitivity(messages_dict, use_vl_model=has_image)
                    compliance_result, security_result = await self._parse_model_response_with_sensitivity(
                        model_response, sensitivity_score, tenant_id, model_sensitivity_trigger_level, application_id
                    )
            else:
                # No application_id: use legacy detection for backward compatibility
                logger.warning(f"No application_id provided, using legacy detection for tenant {tenant_id}")
                matched_scanners = []  # No scanner info for legacy detection
                model_response, sensitivity_score = await model_service.check_messages_with_sensitivity(messages_dict, use_vl_model=has_image)
                compliance_result, security_result = await self._parse_model_response_with_sensitivity(
                    model_response, sensitivity_score, tenant_id, model_sensitivity_trigger_level, application_id
                )

            # 5. Determine suggested action and answer (include data security result)
            overall_risk_level, suggest_action, suggest_answer = await self._determine_action_with_data(
                compliance_result, security_result, data_result, tenant_id, application_id, user_content, data_anonymized_text, matched_scanners
            )

            # 5.1 Append appeal link if applicable (any risk level with reject/replace action)
            if suggest_answer and suggest_action in ['reject', 'replace']:
                try:
                    from services.appeal_service import appeal_service
                    # Get tenant's language preference for appeal page
                    appeal_language = 'zh'  # Default to Chinese
                    if tenant_id:
                        try:
                            from database.models import Tenant
                            tenant = self.db.query(Tenant).filter(Tenant.id == tenant_id).first()
                            if tenant and tenant.language:
                                appeal_language = tenant.language
                        except Exception:
                            pass
                    appeal_link = await appeal_service.generate_appeal_link(
                        request_id=request_id,
                        application_id=application_id,
                        language=appeal_language
                    )
                    if appeal_link:
                        suggest_answer = f"{suggest_answer}\n\n{appeal_link}"
                except Exception as e:
                    logger.warning(f"Failed to generate appeal link: {e}")

            # 6. Asynchronously record detection results to log file (not write to database)
            await self._log_detection_result(
                request_id, user_content, compliance_result, security_result, data_result,
                suggest_action, suggest_answer, model_response,
                ip_address, user_agent, tenant_id, application_id, sensitivity_score,
                has_image=has_image, image_count=len(saved_image_paths), image_paths=saved_image_paths,
                matched_scanner_tags=matched_scanner_tags
            )

            # 7. Construct response
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
                score=sensitivity_score,
            )
            
        except Exception as e:
            logger.error(f"Guardrail check error: {e}")
            # When an error occurs, return safe default response
            return await self._handle_error(request_id, user_content, str(e), tenant_id, application_id)
    
    def _extract_user_content(self, messages: List[Message]) -> str:
        """Extract complete conversation content

        For data leak detection:
        - If last message is assistant (QA pair), extract assistant's response only
        - Otherwise extract user's content

        For logging: always include full conversation context
        """
        if len(messages) == 1 and messages[0].role == 'user':
            content = messages[0].content
            if isinstance(content, str):
                return content
            elif isinstance(content, list):
                # For multi-modal content, only extract text part for log
                text_parts = []
                for part in content:
                    if hasattr(part, 'type') and part.type == 'text' and hasattr(part, 'text'):
                        text_parts.append(part.text)
                    elif hasattr(part, 'type') and part.type == 'image_url':
                        text_parts.append("[Image]")
                return ' '.join(text_parts) if text_parts else "[Multi-modal content]"
        else:
            # Multi-message conversation
            conversation_parts = []
            for msg in messages:
                role_label = "User" if msg.role == "user" else "Assistant" if msg.role == "assistant" else msg.role
                content = msg.content
                if isinstance(content, str):
                    conversation_parts.append(f"[{role_label}]: {content}")
                elif isinstance(content, list):
                    # For multi-modal content, only extract text part
                    text_parts = []
                    for part in content:
                        if hasattr(part, 'type') and part.type == 'text' and hasattr(part, 'text'):
                            text_parts.append(part.text)
                        elif hasattr(part, 'type') and part.type == 'image_url':
                            text_parts.append("[Image]")
                    content_str = ' '.join(text_parts) if text_parts else "[多模态内容]"
                    conversation_parts.append(f"[{role_label}]: {content_str}")
            return '\n'.join(conversation_parts)

    def _extract_content_for_data_detection(self, messages: List[Message], direction: str) -> str:
        """Extract content for data leak detection based on direction

        Args:
            messages: List of messages
            direction: "input" for user input, "output" for assistant output

        Returns:
            Text content to be checked for data leaks
        """
        if direction == "output":
            # For output detection, only check assistant messages
            assistant_parts = []
            for msg in messages:
                if msg.role == "assistant":
                    content = msg.content
                    if isinstance(content, str):
                        assistant_parts.append(content)
                    elif isinstance(content, list):
                        text_parts = []
                        for part in content:
                            if hasattr(part, 'type') and part.type == 'text' and hasattr(part, 'text'):
                                text_parts.append(part.text)
                        if text_parts:
                            assistant_parts.append(' '.join(text_parts))
            return '\n'.join(assistant_parts) if assistant_parts else ""
        else:
            # For input detection, check user messages
            user_parts = []
            for msg in messages:
                if msg.role == "user":
                    content = msg.content
                    if isinstance(content, str):
                        user_parts.append(content)
                    elif isinstance(content, list):
                        text_parts = []
                        for part in content:
                            if hasattr(part, 'type') and part.type == 'text' and hasattr(part, 'text'):
                                text_parts.append(part.text)
                        if text_parts:
                            user_parts.append(' '.join(text_parts))
            return '\n'.join(user_parts) if user_parts else ""
    
    async def _parse_model_response(self, response: str, tenant_id: Optional[str] = None) -> Tuple[ComplianceResult, SecurityResult]:
        """Parse model response and apply risk type filtering"""
        response = response.strip()

        if response == "safe":
            return (
                ComplianceResult(risk_level="no_risk", categories=[]),
                SecurityResult(risk_level="no_risk", categories=[])
            )

        if response.startswith("unsafe\n"):
            category = response.split('\n')[1] if '\n' in response else ""

            # Check if tenant/application has disabled this risk type
            # Note: This method is deprecated and only used for backward compatibility
            # Modern code should use _parse_model_response_with_sensitivity which accepts application_id
            if tenant_id and not await risk_config_cache.is_risk_type_enabled(tenant_id=tenant_id, risk_type=category):
                logger.info(f"Risk type {category} is disabled for user {tenant_id}, treating as safe")
                return (
                    ComplianceResult(risk_level="no_risk", categories=[]),
                    SecurityResult(risk_level="no_risk", categories=[])
                )

            risk_level = RISK_LEVEL_MAPPING.get(category, "medium_risk")
            category_name = CATEGORY_NAMES.get(category, category)

            if category == "S9":  # Prompt injection
                return (
                    ComplianceResult(risk_level="no_risk", categories=[]),
                    SecurityResult(risk_level=risk_level, categories=[category_name])
                )
            else:  # Compliance issues
                return (
                    ComplianceResult(risk_level=risk_level, categories=[category_name]),
                    SecurityResult(risk_level="no_risk", categories=[])
                )

        # Default return safe
        return (
            ComplianceResult(risk_level="no_risk", categories=[]),
            SecurityResult(risk_level="no_risk", categories=[])
        )

    async def _parse_model_response_with_sensitivity(
        self, response: str, sensitivity_score: Optional[float], tenant_id: Optional[str] = None,
        model_sensitivity_trigger_level: Optional[str] = None, application_id: Optional[str] = None
    ) -> Tuple[ComplianceResult, SecurityResult]:
        """Parse model response and apply risk type filtering and sensitivity threshold

        Supports multiple labels separated by commas (e.g., "unsafe\nS2,S5,S7")

        Args:
            response: Model response string
            sensitivity_score: Sensitivity score from model
            tenant_id: Tenant ID (deprecated, kept for backward compatibility)
            model_sensitivity_trigger_level: Sensitivity trigger level override
            application_id: Application ID (preferred for risk config lookup)
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
            # Use application_id if available, otherwise fallback to tenant_id
            enabled_categories = []
            for category in categories:
                is_enabled = await risk_config_cache.is_risk_type_enabled(
                    tenant_id=tenant_id,
                    application_id=application_id,
                    risk_type=category
                )
                if is_enabled:
                    enabled_categories.append(category)

            # If all categories are disabled, treat as safe
            if not enabled_categories:
                cache_key = application_id if application_id else tenant_id
                logger.info(f"All risk types {categories} are disabled for application/user {cache_key}, treating as safe")
                return (
                    ComplianceResult(risk_level="no_risk", categories=[]),
                    SecurityResult(risk_level="no_risk", categories=[])
                )

            # Check sensitivity trigger level (apply to all enabled categories)
            if sensitivity_score is not None and (tenant_id or application_id):
                if not await self._should_trigger_detection(sensitivity_score, tenant_id, application_id):
                    logger.info(f"Sensitivity score {sensitivity_score} below current threshold for {enabled_categories}, treating as safe")
                    return (
                        ComplianceResult(risk_level="no_risk", categories=[]),
                        SecurityResult(risk_level="no_risk", categories=[])
                    )

            # Determine highest risk level from enabled categories
            risk_priority = {"no_risk": 0, "low_risk": 1, "medium_risk": 2, "high_risk": 3}

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
    
    async def _check_data_security(self, text: str, tenant_id: Optional[str], direction: str = "input", application_id: Optional[str] = None) -> Tuple[DataSecurityResult, Optional[str]]:
        """Check data security and return anonymized text

        Returns:
            Tuple of (DataSecurityResult, anonymized_text)
        """
        logger.info(f"_check_data_security called for user {tenant_id}, application {application_id}, direction {direction}")
        if not tenant_id:
            logger.info("No tenant_id, returning safe")
            return DataSecurityResult(risk_level="no_risk", categories=[]), None

        try:
            # Get database session
            db = get_db_session()
            try:
                from services.data_security_service import DataSecurityService
                service = DataSecurityService(db)

                # Execute data security detection
                logger.info(f"Calling detect_sensitive_data for text: {text[:50]}...")
                result = await service.detect_sensitive_data(text, tenant_id, direction, application_id=application_id)
                logger.info(f"Data security detection result: {result}")

                # Return both result and anonymized text
                anonymized_text = result.get('anonymized_text') if result['risk_level'] != 'no_risk' else None
                detected_entities = result.get('detected_entities', []) if result['risk_level'] != 'no_risk' else []
                restore_mapping = result.get('restore_mapping') if result['risk_level'] != 'no_risk' else None

                data_result = DataSecurityResult(
                    risk_level=result['risk_level'],
                    categories=result['categories'],
                    detected_entities=detected_entities,
                    anonymized_text=anonymized_text,
                    restore_mapping=restore_mapping
                )

                return data_result, anonymized_text
            finally:
                db.close()
        except Exception as e:
            logger.error(f"Data security check error: {e}", exc_info=True)
            return DataSecurityResult(risk_level="no_risk", categories=[]), None

    def _get_highest_risk_level(self, categories: List[str]) -> str:
        """Get highest risk level"""
        if not categories:
            return "no_risk"

        risk_levels = []
        for category in categories:
            for code, name in CATEGORY_NAMES.items():
                if name == category:
                    risk_levels.append(RISK_LEVEL_MAPPING[code])
                    break

        if "high_risk" in risk_levels:
            return "high_risk"
        elif "medium_risk" in risk_levels:
            return "medium_risk"
        elif "low_risk" in risk_levels:
            return "low_risk"
        else:
            return "no_risk"

    async def _determine_action_with_data(
        self,
        compliance_result: ComplianceResult,
        security_result: SecurityResult,
        data_result: DataSecurityResult,
        tenant_id: Optional[str] = None,
        application_id: Optional[str] = None,
        user_query: Optional[str] = None,
        data_anonymized_text: Optional[str] = None,
        matched_scanners: Optional[list] = None
    ) -> Tuple[str, str, Optional[str]]:
        """Determine suggested action (include data security detection result)

        Important:
        - For general risks (security + compliance), use template/KB answer
        - For DLP risks, use fixed i18n message (not anonymized text)
        - overall_risk_level considers all three types for logging purposes
        - suggest_action is based on the highest risk from general risks
        - DLP disposal is handled separately in proxy layer
        """
        # Collect all categories for general risks only (not DLP)
        all_categories = []

        if compliance_result.risk_level != "no_risk":
            all_categories.extend(compliance_result.categories)
        if security_result.risk_level != "no_risk":
            all_categories.extend(security_result.categories)

        # Determine general risk level (security + compliance only, NOT DLP)
        general_risk_levels = [compliance_result.risk_level, security_result.risk_level]
        general_risk_level = "no_risk"
        for level in ["high_risk", "medium_risk", "low_risk"]:
            if level in general_risk_levels:
                general_risk_level = level
                break

        # Determine overall risk level (including DLP for logging purposes)
        all_risk_levels = [compliance_result.risk_level, security_result.risk_level, data_result.risk_level]
        overall_risk_level = "no_risk"
        for level in ["high_risk", "medium_risk", "low_risk"]:
            if level in all_risk_levels:
                overall_risk_level = level
                break

        # If no risks at all, pass
        if overall_risk_level == "no_risk":
            return overall_risk_level, "pass", None

        # Determine suggest_answer based on risk type
        suggest_answer = None

        # Case 1: Has general risk (security/compliance) - use template/KB answer
        if general_risk_level != "no_risk":
            suggest_answer = await self._get_suggest_answer(all_categories, tenant_id, application_id, user_query, matched_scanners)
            logger.info(f"Using template answer for general risk: {general_risk_level}")

        # Case 2: Only DLP risk (no general risk) - use data leakage template with entity types
        elif data_result.risk_level != "no_risk":
            # Get user's language preference for i18n
            user_language = 'en'  # Default to English
            if tenant_id:
                try:
                    from database.models import Tenant
                    db = get_db_session()
                    try:
                        tenant = db.query(Tenant).filter(Tenant.id == tenant_id).first()
                        if tenant and tenant.language:
                            user_language = tenant.language
                    finally:
                        db.close()
                except Exception as e:
                    logger.warning(f"Failed to get user language for DLP message: {e}")

            # Use data leakage template with detected entity type names (not codes)
            from services.enhanced_template_service import enhanced_template_service
            # Extract entity_type_name from detected_entities for user-friendly display
            entity_type_names = []
            if data_result.detected_entities:
                seen_names = set()
                for entity in data_result.detected_entities:
                    name = entity.get('entity_type_name') or entity.get('entity_type', '')
                    if name and name not in seen_names:
                        entity_type_names.append(name)
                        seen_names.add(name)
            # Fallback to categories (codes) if no entity_type_name available
            if not entity_type_names:
                entity_type_names = data_result.categories if data_result.categories else []
            suggest_answer = await enhanced_template_service.get_data_leakage_answer(entity_type_names, user_language)
            logger.info(f"Using data leakage template for DLP risk: {data_result.risk_level}, entity_type_names={entity_type_names}")

        # Determine action based on general risk level (DLP handling is done in proxy layer)
        if general_risk_level == "high_risk":
            return overall_risk_level, "reject", suggest_answer
        elif general_risk_level in ["medium_risk", "low_risk"]:
            return overall_risk_level, "replace", suggest_answer
        else:
            # Only DLP risk, no general risk - action depends on DLP policy (handled in proxy)
            # Return "pass" for suggest_action, actual DLP disposal is in proxy layer
            return overall_risk_level, "pass", suggest_answer

    async def _determine_action(self, compliance_result: ComplianceResult, security_result: SecurityResult, tenant_id: Optional[str] = None, application_id: Optional[str] = None, user_query: Optional[str] = None, matched_scanners: Optional[list] = None) -> Tuple[str, str, Optional[str]]:
        """Determine suggested action"""
        overall_risk_level = "no_risk"
        risk_categories = []

        if compliance_result.risk_level != "no_risk":
            overall_risk_level = compliance_result.risk_level
            risk_categories.extend(compliance_result.categories)

        if security_result.risk_level != "no_risk":
            if overall_risk_level == "no_risk" or (overall_risk_level != "high_risk" and security_result.risk_level == "high_risk"):
                overall_risk_level = security_result.risk_level
            risk_categories.extend(security_result.categories)

        if overall_risk_level == "no_risk":
            return overall_risk_level, "pass", None
        elif overall_risk_level == "high_risk":
            suggest_answer = await self._get_suggest_answer(risk_categories, tenant_id, application_id, user_query, matched_scanners)
            return overall_risk_level, "reject", suggest_answer
        elif overall_risk_level == "medium_risk":
            suggest_answer = await self._get_suggest_answer(risk_categories, tenant_id, application_id, user_query, matched_scanners)
            return overall_risk_level, "replace", suggest_answer
        else:  # low_risk
            suggest_answer = await self._get_suggest_answer(risk_categories, tenant_id, application_id, user_query, matched_scanners)
            return overall_risk_level, "replace", suggest_answer
    
    async def _get_suggest_answer(self, categories: List[str], tenant_id: Optional[str] = None, application_id: Optional[str] = None, user_query: Optional[str] = None, matched_scanners: Optional[list] = None) -> str:
        """Get suggested answer (using enhanced template service, support knowledge base search)"""
        from services.enhanced_template_service import enhanced_template_service
        from database.models import Tenant

        # Get user's language preference
        user_language = None
        if tenant_id:
            try:
                db = get_db_session()
                tenant = db.query(Tenant).filter(Tenant.id == tenant_id).first()
                if tenant:
                    user_language = tenant.language
                db.close()
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



    async def _get_sensitivity_trigger_level(self, tenant_id: str = None, application_id: str = None) -> str:
        """Get user/application configured sensitivity trigger level"""
        try:
            from services.risk_config_cache import risk_config_cache
            trigger_level = await risk_config_cache.get_sensitivity_trigger_level(tenant_id=tenant_id, application_id=application_id)
            return trigger_level if trigger_level else "medium"  # Default medium sensitivity trigger
        except Exception as e:
            cache_key = application_id if application_id else tenant_id
            logger.warning(f"Failed to get sensitivity trigger level for {cache_key}: {e}")
            return "medium"  # Default medium sensitivity trigger

    async def _should_trigger_detection(self, sensitivity_score: float, tenant_id: str = None, application_id: str = None) -> bool:
        """Check if should trigger detection based on sensitivity score and current sensitivity level threshold"""
        try:
            # Get user/application current sensitivity level
            current_level = await self._get_sensitivity_trigger_level(tenant_id, application_id)

            # Get sensitivity threshold configuration
            thresholds = await risk_config_cache.get_sensitivity_thresholds(tenant_id=tenant_id, application_id=application_id)

            # Get corresponding threshold based on current sensitivity level
            if current_level == "low":
                threshold = thresholds.get("low", 0.95)
            elif current_level == "medium":
                threshold = thresholds.get("medium", 0.60)
            elif current_level == "high":
                threshold = thresholds.get("high", 0.40)
            else:
                threshold = 0.60  # Default medium sensitivity threshold

            # Trigger when sensitivity score >= current sensitivity threshold
            return sensitivity_score >= threshold

        except Exception as e:
            cache_key = application_id if application_id else tenant_id
            logger.warning(f"Failed to check sensitivity trigger for {cache_key}: {e}")
            # Default use medium sensitivity threshold
            return sensitivity_score >= 0.60
    
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
                db = get_db_session()
                try:
                    tenant = db.query(Tenant).filter(Tenant.id == tenant_id).first()
                    if tenant and tenant.language:
                        user_language = tenant.language
                finally:
                    db.close()
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
            "data_risk_level": "no_risk",
            "data_categories": [],
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
            "data_risk_level": "no_risk",
            "data_categories": [],
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
        security_result: SecurityResult, data_result: DataSecurityResult,
        suggest_action: str, suggest_answer: Optional[str],
        model_response: str, ip_address: Optional[str], user_agent: Optional[str],
        tenant_id: Optional[str] = None, application_id: Optional[str] = None,
        sensitivity_score: Optional[float] = None,
        has_image: bool = False, image_count: int = 0, image_paths: List[str] = None,
        matched_scanner_tags: List[str] = None
    ):
        """Asynchronously record detection results to log file (not write to database)"""

        # Clean NUL characters from content
        from utils.validators import clean_null_characters

        detection_data = {
            "request_id": request_id,
            "tenant_id": tenant_id,
            "application_id": application_id,
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
            "data_risk_level": data_result.risk_level,
            "data_categories": data_result.categories,
            "sensitivity_score": sensitivity_score,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "hit_keywords": None,
            "has_image": has_image,
            "image_count": image_count,
            "image_paths": image_paths or [],
            "matched_scanner_tags": matched_scanner_tags or []
        }
        await async_detection_logger.log_detection(detection_data)
    
    async def _handle_error(self, request_id: str, content: str, error: str, tenant_id: Optional[str] = None, application_id: Optional[str] = None) -> GuardrailResponse:
        """Handle error situation"""

        detection_data = {
            "request_id": request_id,
            "tenant_id": tenant_id,
            "application_id": application_id,
            "content": content,
            "suggest_action": "pass",
            "suggest_answer": None,
            "model_response": f"error: {error}",
            "security_risk_level": "no_risk",
            "security_categories": [],
            "compliance_risk_level": "no_risk",
            "compliance_categories": [],
            "data_risk_level": "no_risk",
            "data_categories": [],
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
            overall_risk_level="no_risk",
            suggest_action="pass",
            suggest_answer=None
        )
# 创建全局实例
detection_guardrail_service = DetectionGuardrailService()
