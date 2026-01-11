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
from services.restore_anonymization_service import get_restore_anonymization_service
from database.models import (
    Application, UpstreamApiConfig, Tenant,
    DataSecurityEntityType, ApplicationDataLeakagePolicy
)
from utils.logger import setup_logger

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
            # 1. Check ban policy
            if user_id:
                ban_record = await BanPolicyService.check_user_banned(tenant_id, user_id)
                if ban_record:
                    return self._create_block_response(
                        request_id=request_id,
                        reason="user_banned",
                        message=f"User has been banned until {ban_record.get('ban_until', 'indefinitely')}",
                        detection_result={"banned": True, "user_id": user_id}
                    )

            if client_ip:
                ip_ban = await BanPolicyService.check_ip_banned(tenant_id, client_ip)
                if ip_ban:
                    return self._create_block_response(
                        request_id=request_id,
                        reason="ip_banned",
                        message="IP address has been banned",
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
                    return self._create_block_response(
                        request_id=request_id,
                        reason="security_risk",
                        message=suggest_answer or "Request blocked due to security policy",
                        detection_result=result_info
                    )

                if general_action == "replace":
                    return self._create_replace_response(
                        request_id=request_id,
                        message=suggest_answer or "I cannot assist with this request.",
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
                    return self._create_block_response(
                        request_id=request_id,
                        reason="data_leakage_policy",
                        message="Request blocked due to sensitive data detection",
                        detection_result=result_info
                    )

                elif disposal_action == "switch_private_model":
                    private_model = self.disposal_service.get_private_model(
                        application_id=application_id,
                        tenant_id=tenant_id
                    )

                    if private_model:
                        return self._create_switch_model_response(
                            request_id=request_id,
                            private_model=private_model,
                            detection_result=result_info
                        )
                    else:
                        # No private model available, fallback to block
                        logger.warning(f"[{request_id}] No private model available, falling back to block")
                        return self._create_block_response(
                            request_id=request_id,
                            reason="no_private_model",
                            message="Sensitive data detected but no private model configured",
                            detection_result=result_info
                        )

                elif disposal_action in ("anonymize", "anonymize_restore"):
                    # Perform anonymization
                    # Enable restore by default for gateway integration (needed for output restoration)
                    anonymized_messages, session_id = self._anonymize_messages(
                        messages=messages,
                        detected_entities=detected_entities,
                        application_id=application_id,
                        tenant_id=tenant_id,
                        enable_restore=True  # Always enable restore for gateway integration
                    )

                    return {
                        "action": "anonymize",
                        "request_id": request_id,
                        "detection_result": result_info,
                        "anonymized_messages": anonymized_messages,
                        "session_id": session_id
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
        is_streaming: bool = False,
        chunk_index: int = 0
    ) -> Dict[str, Any]:
        """
        Process LLM output through detection and optionally restore anonymized data.
        """
        request_id = f"gw-out-{uuid.uuid4().hex[:12]}"

        try:
            # 1. Restore anonymized data if session exists
            restored_content = content
            has_restoration = False

            if session_id:
                session = self._get_session(session_id)
                if session and session.get("mapping"):
                    restored_content = self._restore_content(
                        content=content,
                        mapping=session["mapping"]
                    )
                    has_restoration = True

            # 2. Run output detection (optional, based on config)
            # For now, we detect on the restored content
            messages = [{"role": "assistant", "content": restored_content}]

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
            if suggest_action == "reject":
                return {
                    "action": "block",
                    "request_id": request_id,
                    "detection_result": result_info,
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
                                    "content": suggest_answer or "Response blocked due to security policy."
                                },
                                "finish_reason": "content_filter"
                            }],
                            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
                        })
                    }
                }

            if suggest_action == "replace":
                return {
                    "action": "replace",
                    "request_id": request_id,
                    "detection_result": result_info,
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
                                    "content": suggest_answer or "I cannot provide this information."
                                },
                                "finish_reason": "content_filter"
                            }],
                            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
                        })
                    }
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
        enable_restore: bool = True
    ) -> Tuple[List[Dict[str, Any]], Optional[str]]:
        """
        Anonymize messages and optionally create restore session.

        Returns: (anonymized_messages, session_id)
        """
        if not detected_entities:
            return messages, None

        # Build replacement map
        restore_mapping = {}
        entity_counters = {}

        # Sort by length (longest first) to avoid partial replacements
        sorted_entities = sorted(
            detected_entities,
            key=lambda x: len(x.get('text', '')),
            reverse=True
        )

        replacements = {}

        for entity in sorted_entities:
            original_text = entity.get('text', '')
            if not original_text or original_text in replacements:
                continue

            entity_type = entity.get('entity_type', 'UNKNOWN').lower()

            if enable_restore:
                # Generate numbered placeholder for restoration
                counter = entity_counters.get(entity_type, 0) + 1
                entity_counters[entity_type] = counter
                placeholder = f"[{entity_type}_{counter}]"

                replacements[original_text] = placeholder
                restore_mapping[placeholder] = original_text
            else:
                # Use pre-computed anonymized value
                anonymized = entity.get('anonymized_value')
                if anonymized:
                    replacements[original_text] = anonymized
                else:
                    replacements[original_text] = f"<{entity_type.upper()}>"

        # Apply replacements to messages
        anonymized_messages = []
        for msg in messages:
            new_msg = msg.copy()
            content = msg.get('content', '')

            if isinstance(content, str) and msg.get('role') == 'user':
                for original, replacement in sorted(
                    replacements.items(),
                    key=lambda x: len(x[0]),
                    reverse=True
                ):
                    content = content.replace(original, replacement)
                new_msg['content'] = content

            anonymized_messages.append(new_msg)

        # Create session if restore is enabled
        session_id = None
        if enable_restore and restore_mapping:
            session_id = self._create_session(
                mapping=restore_mapping,
                tenant_id=tenant_id
            )

        return anonymized_messages, session_id

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
        """Restore anonymized placeholders in content"""
        result = content

        # Sort by placeholder length (longest first) to avoid partial matches
        for placeholder, original in sorted(
            mapping.items(),
            key=lambda x: len(x[0]),
            reverse=True
        ):
            result = result.replace(placeholder, original)

        return result

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

    def _create_switch_model_response(
        self,
        request_id: str,
        private_model: UpstreamApiConfig,
        detection_result: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Create a switch private model action response"""
        # Decrypt API key for the gateway using shared cipher suite
        decrypted_key = ""
        try:
            if private_model.api_key_encrypted:
                cipher = _get_cipher_suite()
                decrypted_key = cipher.decrypt(private_model.api_key_encrypted.encode()).decode()
        except Exception as e:
            logger.error(f"Failed to decrypt private model API key: {e}")
            decrypted_key = ""

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
            }
        }


def get_gateway_integration_service(db: Session) -> GatewayIntegrationService:
    """Factory function to get gateway integration service"""
    return GatewayIntegrationService(db)
