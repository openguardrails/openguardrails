"""
Gateway Integration Service

Provides unified API for third-party AI gateways (Higress, LiteLLM, Kong, etc.)
to integrate OpenGuardrails' full security capabilities including:
- Blacklist/Whitelist checking
- Data Leakage Prevention (DLP)
- Security/Compliance scanning (21 risk categories)
- Anonymization with restoration
- Private model switching
"""

import os
import uuid
import json
import time
import hashlib
from typing import Dict, Any, Optional, List, Tuple
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from cryptography.fernet import Fernet

from services.detection_guardrail_service import detection_guardrail_service
from services.data_leakage_disposal_service import DataLeakageDisposalService
from services.ban_policy_service import BanPolicyService
from services.unified_anonymization_service import get_unified_anonymization_service
from database.models import (
    Application, UpstreamApiConfig, Tenant,
    DataSecurityEntityType, ApplicationDataLeakagePolicy
)
from database.connection import get_db_session
from utils.logger import setup_logger
from utils.i18n_loader import get_translation
from utils.bypass_token import generate_bypass_token, BYPASS_TOKEN_HEADER

logger = setup_logger()

# Shared cipher suite for API key encryption/decryption
_cipher_suite = None

def _get_cipher_suite() -> Fernet:
    """Get or create the shared cipher suite"""
    global _cipher_suite
    if _cipher_suite is None:
        from config import settings
        key_file = f"{settings.data_dir}/proxy_encryption.key"
        os.makedirs(os.path.dirname(key_file), exist_ok=True)

        if os.path.exists(key_file):
            with open(key_file, "rb") as f:
                encryption_key = f.read()
        else:
            encryption_key = Fernet.generate_key()
            with open(key_file, "wb") as f:
                f.write(encryption_key)

        _cipher_suite = Fernet(encryption_key)
    return _cipher_suite

# In-memory session store with TTL (for production, use Redis)
# Format: {session_id: {"mapping": {...}, "expires_at": timestamp, "tenant_id": str}}
_session_store: Dict[str, Dict[str, Any]] = {}
SESSION_TTL_SECONDS = 3600  # 1 hour


class GatewayIntegrationService:
    """Service for third-party gateway integration"""

    def __init__(self, db: Session):
        self.db = db
        self.disposal_service = DataLeakageDisposalService(db)

    def _get_language(self, tenant_id: Optional[str]) -> str:
        """
        Get language preference for tenant.
        
        Args:
            tenant_id: Tenant ID
            
        Returns:
            Language code ('en' or 'zh'), defaults to 'en'
        """
        if not tenant_id:
            return 'en'
        
        try:
            tenant = self.db.query(Tenant).filter(Tenant.id == tenant_id).first()
            if tenant and tenant.language:
                return tenant.language
        except Exception as e:
            logger.warning(f"Failed to get language for tenant {tenant_id}: {e}")
        
        return 'en'

    async def process_input(
        self,
        application_id: str,
        tenant_id: str,
        messages: List[Dict[str, Any]],
        stream: bool = False,
        client_ip: Optional[str] = None,
        user_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Process incoming messages through full detection pipeline.

        Returns disposition action and any necessary modifications.
        """
        request_id = f"gw-{uuid.uuid4().hex[:12]}"

        try:
            # Get language preference for i18n messages
            language = self._get_language(tenant_id)

            # 1. Check ban policy
            if user_id:
                ban_record = await BanPolicyService.check_user_banned(tenant_id, user_id)
                if ban_record:
                    ban_until = ban_record.get('ban_until', 'indefinitely')
                    message_template = get_translation(language, 'guardrail', 'userBannedUntil')
                    message = message_template.format(ban_until=ban_until)
                    return self._create_block_response(
                        request_id=request_id,
                        reason="user_banned",
                        message=message,
                        detection_result={"banned": True, "user_id": user_id}
                    )

            if client_ip:
                ip_ban = await BanPolicyService.check_ip_banned(tenant_id, client_ip)
                if ip_ban:
                    message = get_translation(language, 'guardrail', 'ipAddressBanned')
                    return self._create_block_response(
                        request_id=request_id,
                        reason="ip_banned",
                        message=message,
                        detection_result={"banned": True, "client_ip": client_ip}
                    )

            # 2. Run full detection
            detection_result = await detection_guardrail_service.detect_messages(
                messages=messages,
                tenant_id=tenant_id,
                request_id=request_id,
                application_id=application_id
            )

            # 3. Parse detection results
            suggest_action = detection_result.get("suggest_action", "pass")
            suggest_answer = detection_result.get("suggest_answer")
            overall_risk = detection_result.get("overall_risk_level", "no_risk")

            compliance_result = detection_result.get("compliance_result") or {}
            security_result = detection_result.get("security_result") or {}
            data_result = detection_result.get("data_result") or {}

            # Build detection result for response
            result_info = {
                "blacklist_hit": suggest_action == "reject" and not data_result.get("risk_level"),
                "blacklist_keywords": [],
                "whitelist_hit": suggest_action == "pass" and overall_risk == "no_risk",
                "data_risk": {
                    "risk_level": data_result.get("risk_level", "no_risk"),
                    "categories": data_result.get("categories", []),
                    "entity_count": len(data_result.get("detected_entities", []))
                },
                "compliance_risk": {
                    "risk_level": compliance_result.get("risk_level", "no_risk"),
                    "categories": compliance_result.get("categories", [])
                },
                "security_risk": {
                    "risk_level": security_result.get("risk_level", "no_risk"),
                    "categories": security_result.get("categories", [])
                },
                "overall_risk_level": overall_risk,
                "matched_scanners": []
            }

            # 4. Determine action based on detection results

            # Check if we have actual security/compliance risks (not just DLP)
            has_security_risk = bool(security_result.get("categories"))
            has_compliance_risk = bool(compliance_result.get("categories"))
            has_dlp_risk = data_result.get("risk_level") not in (None, "no_risk")

            # 4a. Security/Compliance risks - use policy-based action determination
            # Only apply if there are actual security/compliance categories (not DLP)
            if has_security_risk or has_compliance_risk:
                # Get action from policy instead of using hardcoded logic
                general_action = self.disposal_service.get_general_risk_action(
                    application_id=application_id,
                    risk_level=overall_risk
                )

                logger.info(f"[{request_id}] General risk: {overall_risk}, policy action: {general_action}")

                if general_action == "block":
                    if not suggest_answer:
                        suggest_answer = get_translation(language, 'guardrail', 'securityPolicyBlocked')
                    return self._create_block_response(
                        request_id=request_id,
                        reason="security_risk",
                        message=suggest_answer,
                        detection_result=result_info
                    )

                if general_action == "replace":
                    if not suggest_answer:
                        suggest_answer = get_translation(language, 'guardrail', 'cannotAssist')
                    return self._create_replace_response(
                        request_id=request_id,
                        message=suggest_answer,
                        detection_result=result_info
                    )

                # If general_action == "pass", continue to check DLP risks

            # 4b. Data leakage risks - get disposal action from policy
            data_risk_level = data_result.get("risk_level", "no_risk")
            detected_entities = data_result.get("detected_entities", [])

            if data_risk_level != "no_risk" and detected_entities:
                disposal_action = self.disposal_service.get_disposal_action(
                    application_id=application_id,
                    risk_level=data_risk_level,
                    direction="input"
                )

                logger.info(f"[{request_id}] Data risk: {data_risk_level}, disposal: {disposal_action}")

                if disposal_action == "block":
                    message = get_translation(language, 'guardrail', 'sensitiveDataPolicyViolation')
                    return self._create_block_response(
                        request_id=request_id,
                        reason="data_leakage_policy",
                        message=message,
                        detection_result=result_info
                    )

                elif disposal_action == "switch_private_model":
                    private_model = self.disposal_service.get_private_model(
                        application_id=application_id,
                        tenant_id=tenant_id
                    )

                    if private_model:
                        # Return switch_private_model action for gateway plugin to handle
                        # This approach supports streaming output and normal output detection flow
                        # The plugin will:
                        # 1. Switch upstream to private model (via headers/cluster)
                        # 2. Add bypass token to skip detection on private model request
                        # 3. Handle the response normally (streaming + output detection)
                        logger.info(f"[{request_id}] Returning switch_private_model action for gateway to handle")
                        return self._create_switch_model_response(
                            request_id=request_id,
                            private_model=private_model,
                            detection_result=result_info,
                            tenant_id=tenant_id
                        )
                    else:
                        # No private model available, fallback to block
                        logger.warning(f"[{request_id}] No private model available, falling back to block")
                        message = get_translation(language, 'guardrail', 'noPrivateModelConfigured')
                        return self._create_block_response(
                            request_id=request_id,
                            reason="no_private_model",
                            message=message,
                            detection_result=result_info
                        )

                elif disposal_action in ("anonymize", "anonymize_restore"):
                    # Perform anonymization using the disposal action directly
                    # 'anonymize' uses entity type's configured method
                    # 'anonymize_restore' uses __entity_type_N__ placeholders for restoration
                    anonymized_messages, session_id, restore_mapping = self._anonymize_messages(
                        messages=messages,
                        detected_entities=detected_entities,
                        application_id=application_id,
                        tenant_id=tenant_id,
                        action=disposal_action
                    )

                    return {
                        "action": "anonymize",
                        "request_id": request_id,
                        "detection_result": result_info,
                        "anonymized_messages": anonymized_messages,
                        "session_id": session_id,
                        "restore_mapping": restore_mapping  # Include mapping for gateway to pass back
                    }

            # 5. No risk or pass action
            return {
                "action": "pass",
                "request_id": request_id,
                "detection_result": result_info
            }

        except Exception as e:
            logger.error(f"[{request_id}] Gateway process_input error: {e}")
            # On error, return pass to avoid blocking legitimate requests
            return {
                "action": "pass",
                "request_id": request_id,
                "detection_result": {
                    "error": str(e),
                    "overall_risk_level": "unknown"
                }
            }

    async def process_output(
        self,
        application_id: str,
        tenant_id: str,
        content: str,
        session_id: Optional[str] = None,
        restore_mapping: Optional[Dict[str, str]] = None,
        is_streaming: bool = False,
        chunk_index: int = 0,
        input_messages: Optional[List[Dict[str, Any]]] = None
    ) -> Dict[str, Any]:
        """
        Process LLM output through detection and optionally restore anonymized data.

        Args:
            restore_mapping: Mapping of placeholders to original values (preferred over session_id).
                           This is passed directly from the gateway, avoiding in-memory session issues.
            input_messages: Optional input messages to provide context for output detection.
                           This helps the model understand the conversation context.
        """
        request_id = f"gw-out-{uuid.uuid4().hex[:12]}"

        # Get language preference for i18n messages
        language = self._get_language(tenant_id)

        try:
            # 1. Restore anonymized data using restore_mapping (preferred) or session
            restored_content = content
            has_restoration = False
            effective_mapping = None

            # Prefer restore_mapping passed directly from gateway (avoids multi-process issues)
            if restore_mapping:
                effective_mapping = restore_mapping
                logger.info(f"[{request_id}] Using restore_mapping from request: {len(restore_mapping)} entries")
            elif session_id:
                # Fallback to session-based lookup (may fail in multi-worker setup)
                session = self._get_session(session_id)
                if session and session.get("mapping"):
                    effective_mapping = session["mapping"]
                    logger.info(f"[{request_id}] Using mapping from session: {len(effective_mapping)} entries")
                else:
                    logger.warning(f"[{request_id}] Session {session_id} not found or has no mapping (multi-worker issue?)")

            if effective_mapping:
                restored_content = self._restore_content(
                    content=content,
                    mapping=effective_mapping
                )
                has_restoration = True

            # 2. Run output detection (optional, based on config)
            # Include input messages as context if provided
            messages = []
            if input_messages:
                # Add input messages as context (copy to avoid modifying original)
                messages.extend(input_messages)
                logger.info(f"[{request_id}] Output detection with {len(input_messages)} input messages as context")
            # Append the assistant's response
            messages.append({"role": "assistant", "content": restored_content})

            logger.info(f"[{request_id}] Output detection: total messages={len(messages)}, output_len={len(restored_content)}")

            detection_result = await detection_guardrail_service.detect_messages(
                messages=messages,
                tenant_id=tenant_id,
                request_id=request_id,
                application_id=application_id
            )

            suggest_action = detection_result.get("suggest_action", "pass")
            suggest_answer = detection_result.get("suggest_answer")
            overall_risk = detection_result.get("overall_risk_level", "no_risk")

            data_result = detection_result.get("data_result") or {}
            compliance_result = detection_result.get("compliance_result") or {}
            security_result = detection_result.get("security_result") or {}

            result_info = {
                "data_risk": {
                    "risk_level": data_result.get("risk_level", "no_risk"),
                    "categories": data_result.get("categories", [])
                },
                "compliance_risk": {
                    "risk_level": compliance_result.get("risk_level", "no_risk"),
                    "categories": compliance_result.get("categories", [])
                },
                "security_risk": {
                    "risk_level": security_result.get("risk_level", "no_risk"),
                    "categories": security_result.get("categories", [])
                },
                "overall_risk_level": overall_risk
            }

            # 3. Handle output risks

            # Check if we have actual security/compliance risks (not just DLP)
            has_security_risk = bool(security_result.get("categories"))
            has_compliance_risk = bool(compliance_result.get("categories"))
            has_dlp_risk = data_result.get("risk_level") not in (None, "no_risk")

            # 3a. Security/Compliance risks - use policy-based action determination
            if has_security_risk or has_compliance_risk:
                # Get action from policy for output direction
                general_action = self.disposal_service.get_general_risk_action(
                    application_id=application_id,
                    risk_level=overall_risk,
                    direction="output"
                )

                logger.info(f"[{request_id}] Output general risk: {overall_risk}, policy action: {general_action}")

                if general_action == "block":
                    if not suggest_answer:
                        suggest_answer = get_translation(language, 'guardrail', 'responseBlockedSecurity')
                    return self._create_block_response(
                        request_id=request_id,
                        reason="security_risk",
                        message=suggest_answer,
                        detection_result=result_info
                    )

                if general_action == "replace":
                    if not suggest_answer:
                        suggest_answer = get_translation(language, 'guardrail', 'cannotProvideInformation')
                    return self._create_replace_response(
                        request_id=request_id,
                        message=suggest_answer,
                        detection_result=result_info
                    )

                # If general_action == "pass", continue to check DLP risks

            # 3b. Data leakage risks - get disposal action from policy
            data_risk_level = data_result.get("risk_level", "no_risk")
            detected_entities = data_result.get("detected_entities", [])

            if data_risk_level != "no_risk" and detected_entities:
                disposal_action = self.disposal_service.get_disposal_action(
                    application_id=application_id,
                    risk_level=data_risk_level,
                    direction="output"
                )

                logger.info(f"[{request_id}] Output data risk: {data_risk_level}, disposal: {disposal_action}")

                if disposal_action == "block":
                    message = get_translation(language, 'guardrail', 'responseBlockedDataLeakage')
                    return self._create_block_response(
                        request_id=request_id,
                        reason="data_leakage_policy",
                        message=message,
                        detection_result=result_info
                    )

                elif disposal_action == "anonymize":
                    # Anonymize sensitive data in output
                    anonymized_content = self._anonymize_output_content(
                        content=restored_content,
                        detected_entities=detected_entities
                    )
                    return {
                        "action": "anonymize",
                        "request_id": request_id,
                        "detection_result": result_info,
                        "anonymized_content": anonymized_content
                    }

            # 4. Return restored/original content
            if has_restoration:
                return {
                    "action": "restore",
                    "request_id": request_id,
                    "detection_result": result_info,
                    "restored_content": restored_content,
                    "buffer_pending": ""
                }
            else:
                return {
                    "action": "pass",
                    "request_id": request_id,
                    "detection_result": result_info,
                    "content": content
                }

        except Exception as e:
            logger.error(f"[{request_id}] Gateway process_output error: {e}")
            return {
                "action": "pass",
                "request_id": request_id,
                "detection_result": {"error": str(e)},
                "content": content
            }

    def _anonymize_messages(
        self,
        messages: List[Dict[str, Any]],
        detected_entities: List[Dict[str, Any]],
        application_id: str,
        tenant_id: str,
        action: str = 'anonymize_restore'
    ) -> Tuple[List[Dict[str, Any]], Optional[str], Optional[Dict[str, str]]]:
        """
        Anonymize messages using UnifiedAnonymizationService.

        Args:
            messages: List of message dicts
            detected_entities: List of detected entities
            application_id: Application ID
            tenant_id: Tenant ID
            action: 'anonymize' (uses configured method) or 'anonymize_restore' (uses __placeholder__)

        Returns: (anonymized_messages, session_id, restore_mapping)
        """
        if not detected_entities:
            return messages, None, None

        # Use unified anonymization service
        anonymization_service = get_unified_anonymization_service()
        anonymized_messages, restore_mapping = anonymization_service.anonymize_messages(
            messages=messages,
            detected_entities=detected_entities,
            action=action,
            application_id=application_id,
            tenant_id=tenant_id
        )

        # Create session if we have a restore mapping (anonymize_restore action)
        # Note: Session is kept for backward compatibility, but restore_mapping
        # should be preferred for multi-worker deployments
        session_id = None
        if restore_mapping:
            session_id = self._create_session(
                mapping=restore_mapping,
                tenant_id=tenant_id
            )

        return anonymized_messages, session_id, restore_mapping

    def _create_session(self, mapping: Dict[str, str], tenant_id: str) -> str:
        """Create a new restore session"""
        session_id = f"sess_{uuid.uuid4().hex[:16]}"
        expires_at = time.time() + SESSION_TTL_SECONDS

        _session_store[session_id] = {
            "mapping": mapping,
            "tenant_id": tenant_id,
            "expires_at": expires_at,
            "created_at": time.time()
        }

        # Cleanup expired sessions periodically
        self._cleanup_expired_sessions()

        logger.info(f"Created restore session {session_id} with {len(mapping)} mappings")
        return session_id

    def _get_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Get session if it exists and is not expired"""
        session = _session_store.get(session_id)
        if not session:
            return None

        if session.get("expires_at", 0) < time.time():
            del _session_store[session_id]
            return None

        return session

    def _cleanup_expired_sessions(self):
        """Remove expired sessions"""
        current_time = time.time()
        expired = [
            sid for sid, sess in _session_store.items()
            if sess.get("expires_at", 0) < current_time
        ]
        for sid in expired:
            del _session_store[sid]

        if expired:
            logger.debug(f"Cleaned up {len(expired)} expired sessions")

    def _restore_content(self, content: str, mapping: Dict[str, str]) -> str:
        """Restore anonymized placeholders in content using UnifiedAnonymizationService"""
        if not mapping or not content:
            return content

        anonymization_service = get_unified_anonymization_service()
        return anonymization_service.restore_content(content, mapping)

    def _anonymize_output_content(
        self,
        content: str,
        detected_entities: List[Dict[str, Any]]
    ) -> str:
        """
        Anonymize sensitive data in output content using UnifiedAnonymizationService.

        For output, we always use 'anonymize' action (one-way, using configured method).
        Output does not support 'anonymize_restore' since there's no opportunity to restore.

        Args:
            content: The content to anonymize
            detected_entities: List of detected entities with text and entity_type

        Returns:
            Anonymized content with sensitive data replaced
        """
        if not detected_entities:
            return content

        anonymization_service = get_unified_anonymization_service()
        anonymized_content, _ = anonymization_service.anonymize_content(
            content=content,
            detected_entities=detected_entities,
            action='anonymize'  # Output always uses one-way anonymization
        )
        return anonymized_content

    def _create_block_response(
        self,
        request_id: str,
        reason: str,
        message: str,
        detection_result: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Create a block action response with OpenAI-compatible ChatCompletion format"""
        return {
            "action": "block",
            "request_id": request_id,
            "detection_result": detection_result,
            "block_response": {
                "code": 200,
                "content_type": "application/json",
                "body": json.dumps({
                    "id": f"chatcmpl-blocked-{request_id}",
                    "object": "chat.completion",
                    "model": "openguardrails-security",
                    "choices": [{
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": message
                        },
                        "finish_reason": "content_filter"
                    }],
                    "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
                })
            }
        }

    def _create_replace_response(
        self,
        request_id: str,
        message: str,
        detection_result: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Create a replace action response with OpenAI-compatible ChatCompletion format"""
        return {
            "action": "replace",
            "request_id": request_id,
            "detection_result": detection_result,
            "replace_response": {
                "code": 200,
                "content_type": "application/json",
                "body": json.dumps({
                    "id": f"chatcmpl-replaced-{request_id}",
                    "object": "chat.completion",
                    "model": "openguardrails-security",
                    "choices": [{
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": message
                        },
                        "finish_reason": "content_filter"
                    }],
                    "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
                })
            }
        }

    async def _proxy_to_private_model(
        self,
        request_id: str,
        private_model: UpstreamApiConfig,
        messages: List[Dict[str, Any]],
        tenant_id: str,
        stream: bool = False,
        original_request_body: Optional[Dict[str, Any]] = None
    ) -> Optional[Dict[str, Any]]:
        """
        Proxy request to private model and return the response.

        This allows OG to directly forward requests to private models
        instead of returning switch_private_model action for gateway to handle.

        When the private model is also protected by OG, a bypass token is added
        to the request headers to skip duplicate detection.

        Returns:
            Dict with action='proxy_response' and the model's response,
            or None if proxy fails.
        """
        import httpx

        try:
            # Build API URL first (needed for model detection)
            api_base = private_model.api_base_url.rstrip('/')

            # Decrypt API key
            decrypted_key = ""
            if private_model.api_key_encrypted:
                try:
                    cipher = _get_cipher_suite()
                    decrypted_key = cipher.decrypt(private_model.api_key_encrypted.encode()).decode()
                except Exception as e:
                    logger.error(f"[{request_id}] Failed to decrypt private model API key: {e}")

            # Build request body
            model_name = private_model.default_private_model_name

            # If no default model name configured, fetch first available model from the API
            if not model_name:
                try:
                    async with httpx.AsyncClient(timeout=10.0) as client:
                        models_url = f"{api_base}/models"
                        models_headers = {"Content-Type": "application/json"}
                        if decrypted_key:
                            models_headers["Authorization"] = f"Bearer {decrypted_key}"
                        models_response = await client.get(models_url, headers=models_headers)
                        if models_response.status_code == 200:
                            models_data = models_response.json()
                            if models_data.get("data") and len(models_data["data"]) > 0:
                                model_name = models_data["data"][0].get("id")
                                logger.info(f"[{request_id}] Auto-detected private model name: {model_name}")
                except Exception as e:
                    logger.warning(f"[{request_id}] Failed to auto-detect model name: {e}")

            # Final fallback
            if not model_name:
                model_name = "gpt-4"
                logger.warning(f"[{request_id}] Using fallback model name: {model_name}")

            request_body = {
                "model": model_name,
                "messages": messages,
                "stream": stream
            }

            # Add additional parameters from original request if available
            if original_request_body:
                for key in ["temperature", "max_tokens", "top_p", "frequency_penalty", "presence_penalty"]:
                    if key in original_request_body:
                        request_body[key] = original_request_body[key]

            # Build API URL
            api_url = f"{api_base}/chat/completions"

            # Prepare headers
            headers = {
                "Content-Type": "application/json"
            }
            if decrypted_key:
                headers["Authorization"] = f"Bearer {decrypted_key}"

            # Add bypass token to skip duplicate detection when private model is also OG-protected
            bypass_token = generate_bypass_token(tenant_id, request_id)
            headers[BYPASS_TOKEN_HEADER] = bypass_token
            logger.info(f"[{request_id}] Added bypass token for private model request")

            logger.info(f"[{request_id}] Proxying to private model: url={api_url}, model={model_name}")

            # Send request to private model (non-streaming only for now)
            if stream:
                # For streaming, we can't easily proxy through OG
                # Return None to fallback to switch_private_model action
                logger.warning(f"[{request_id}] Streaming not supported for private model proxy, falling back")
                return None

            async with httpx.AsyncClient(timeout=120.0) as client:
                response = await client.post(
                    api_url,
                    json=request_body,
                    headers=headers
                )

                if response.status_code != 200:
                    logger.error(f"[{request_id}] Private model returned error: {response.status_code} {response.text}")
                    # Log more details for debugging
                    logger.error(f"[{request_id}] Request was: url={api_url}, model={model_name}, messages_count={len(messages)}")
                    return None

                response_data = response.json()

                logger.info(f"[{request_id}] Private model response received successfully")

                # Return proxy_response action with the model's response
                return {
                    "action": "proxy_response",
                    "request_id": request_id,
                    "proxy_response": {
                        "code": 200,
                        "content_type": "application/json",
                        "body": json.dumps(response_data)
                    }
                }

        except httpx.TimeoutException as e:
            logger.error(f"[{request_id}] Private model request timeout: {e}")
            return None
        except httpx.RequestError as e:
            logger.error(f"[{request_id}] Private model request error: {e}")
            return None
        except Exception as e:
            logger.error(f"[{request_id}] Private model proxy error: {e}")
            return None

    def _create_switch_model_response(
        self,
        request_id: str,
        private_model: UpstreamApiConfig,
        detection_result: Dict[str, Any],
        tenant_id: str
    ) -> Dict[str, Any]:
        """Create a switch private model action response with bypass token"""
        # Decrypt API key for the gateway using shared cipher suite
        decrypted_key = ""
        try:
            if private_model.api_key_encrypted:
                cipher = _get_cipher_suite()
                decrypted_key = cipher.decrypt(private_model.api_key_encrypted.encode()).decode()
        except Exception as e:
            logger.error(f"Failed to decrypt private model API key: {e}")
            decrypted_key = ""

        # Generate bypass token for the gateway to add when forwarding to private model
        bypass_token = generate_bypass_token(tenant_id, request_id)

        return {
            "action": "switch_private_model",
            "request_id": request_id,
            "detection_result": detection_result,
            "private_model": {
                "api_base_url": private_model.api_base_url,
                "api_key": decrypted_key,
                "model_name": private_model.default_private_model_name or "gpt-4",
                "provider": private_model.provider,
                "higress_cluster": private_model.higress_cluster  # Higress cluster for routing
            },
            "bypass_token": bypass_token,
            "bypass_header": BYPASS_TOKEN_HEADER
        }


def get_gateway_integration_service(db: Session) -> GatewayIntegrationService:
    """Factory function to get gateway integration service"""
    return GatewayIntegrationService(db)
