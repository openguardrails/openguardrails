"""
Unified Anonymization Service

Provides a single entry point for all anonymization needs, used by both:
- OG Native Gateway (proxy_api.py)
- Higress Integration (gateway_integration_service.py)

Key design decisions:
1. anonymize action: Uses the anonymization_method configured on entity type
   (mask, hash, replace, genai_natural, genai_code, shuffle, random, regex_replace)
   Result is stored in entity's 'anonymized_value' field

2. anonymize_restore action: Always uses simple placeholder format __entity_type_N__
   No complex anonymization, just simple placeholder -> original value mapping
   Ignores the configured anonymization_method
"""

import re
import logging
from typing import Dict, List, Tuple, Optional, Any

logger = logging.getLogger(__name__)


class UnifiedAnonymizationService:
    """
    Unified service for message anonymization.

    Handles both 'anonymize' (one-way) and 'anonymize_restore' (with restoration) actions.
    """

    # Placeholder format for anonymize_restore: __entity_type_N__
    PLACEHOLDER_PATTERN = re.compile(r'__[a-z_]+_\d+__')

    def anonymize_messages(
        self,
        messages: List[Dict[str, Any]],
        detected_entities: List[Dict[str, Any]],
        action: str,  # 'anonymize' or 'anonymize_restore'
        application_id: Optional[str] = None,
        tenant_id: Optional[str] = None
    ) -> Tuple[List[Dict[str, Any]], Optional[Dict[str, str]]]:
        """
        Unified entry point for message anonymization.

        Args:
            messages: List of message dicts with 'role' and 'content'
            detected_entities: List of detected entity dicts from data_security_service
                Each entity should contain: text, entity_type, anonymized_value (for anonymize action)
            action: 'anonymize' or 'anonymize_restore'
            application_id: Optional application ID for context
            tenant_id: Optional tenant ID for context

        Returns:
            Tuple of (anonymized_messages, restore_mapping)
            - For 'anonymize': restore_mapping is None
            - For 'anonymize_restore': restore_mapping contains __placeholder__ -> original mappings
        """
        if not detected_entities:
            return messages, None

        if action == 'anonymize_restore':
            return self._anonymize_with_restore(messages, detected_entities)
        else:
            # 'anonymize' action - use pre-computed anonymized_value
            return self._anonymize_only(messages, detected_entities), None

    def _anonymize_only(
        self,
        messages: List[Dict[str, Any]],
        detected_entities: List[Dict[str, Any]]
    ) -> List[Dict[str, Any]]:
        """
        Anonymize messages using pre-computed anonymized_value.

        Uses the 'anonymized_value' field from detected_entities, which was
        pre-computed by data_security_service based on the entity type's
        configured anonymization_method (mask, hash, genai_natural, genai_code, etc.)
        """
        # Build replacement map using pre-computed anonymized_value
        entity_replacements = {}

        # Sort by text length (longest first) to avoid partial replacements
        sorted_entities = sorted(
            detected_entities,
            key=lambda x: len(x.get('text', '')),
            reverse=True
        )

        for entity in sorted_entities:
            original_text = entity.get('text', '')
            if not original_text or original_text in entity_replacements:
                continue

            # Use pre-computed anonymized_value from data_security_service
            anonymized_value = entity.get('anonymized_value')
            if anonymized_value is not None:
                entity_replacements[original_text] = anonymized_value
            else:
                # Fallback if anonymized_value not pre-computed
                entity_type = entity.get('entity_type', 'UNKNOWN')
                entity_replacements[original_text] = f"<{entity_type}>"
                logger.warning(f"Entity {entity_type} missing anonymized_value, using fallback")

        # Anonymize each user message
        return self._apply_replacements(messages, entity_replacements)

    def _anonymize_with_restore(
        self,
        messages: List[Dict[str, Any]],
        detected_entities: List[Dict[str, Any]]
    ) -> Tuple[List[Dict[str, Any]], Dict[str, str]]:
        """
        Anonymize messages using simple __entity_type_N__ placeholders.

        Returns a restore_mapping that can be used to restore original values
        in the LLM output.

        Placeholder format: __entity_type_N__ (double underscores)
        Example: __email_1__, __phone_number_1__, __id_card_number_2__
        """
        entity_replacements = {}
        restore_mapping = {}
        entity_counters = {}

        # Sort by text length (longest first) to avoid partial replacements
        sorted_entities = sorted(
            detected_entities,
            key=lambda x: len(x.get('text', '')),
            reverse=True
        )

        for entity in sorted_entities:
            original_text = entity.get('text', '')
            if not original_text or original_text in entity_replacements:
                continue

            # Generate numbered placeholder
            entity_type = entity.get('entity_type', 'unknown').lower()
            counter = entity_counters.get(entity_type, 0) + 1
            entity_counters[entity_type] = counter

            # Placeholder format: __entity_type_N__
            placeholder = f"__{entity_type}_{counter}__"

            entity_replacements[original_text] = placeholder
            restore_mapping[placeholder] = original_text

        # Anonymize each user message
        anonymized_messages = self._apply_replacements(messages, entity_replacements)

        logger.debug(f"Anonymized with restore: {len(entity_replacements)} entities, "
                    f"{len(restore_mapping)} placeholders")

        return anonymized_messages, restore_mapping

    def _apply_replacements(
        self,
        messages: List[Dict[str, Any]],
        replacements: Dict[str, str]
    ) -> List[Dict[str, Any]]:
        """
        Apply replacements to user messages.
        """
        if not replacements:
            return messages

        modified_messages = []

        # Sort by length (longest first) to avoid partial replacements
        sorted_replacements = sorted(
            replacements.items(),
            key=lambda x: len(x[0]),
            reverse=True
        )

        for msg in messages:
            if msg.get('role') == 'user':
                content = msg.get('content', '')
                if isinstance(content, str):
                    anonymized_content = content
                    for original, replacement in sorted_replacements:
                        anonymized_content = anonymized_content.replace(original, replacement)

                    modified_msg = msg.copy()
                    modified_msg['content'] = anonymized_content
                    modified_messages.append(modified_msg)
                else:
                    # Non-string content (e.g., multimodal), keep as is
                    modified_messages.append(msg.copy())
            else:
                # Non-user messages, keep as is
                modified_messages.append(msg.copy())

        return modified_messages

    def anonymize_content(
        self,
        content: str,
        detected_entities: List[Dict[str, Any]],
        action: str = 'anonymize'
    ) -> Tuple[str, Optional[Dict[str, str]]]:
        """
        Anonymize a single content string.
        Used for output anonymization where action is typically 'anonymize' (no restore).

        Args:
            content: Text content to anonymize
            detected_entities: List of detected entity dicts
            action: 'anonymize' or 'anonymize_restore'

        Returns:
            Tuple of (anonymized_content, restore_mapping or None)
        """
        if not detected_entities:
            return content, None

        # Build replacement map
        entity_replacements = {}
        restore_mapping = {}
        entity_counters = {}

        # Sort by text length (longest first)
        sorted_entities = sorted(
            detected_entities,
            key=lambda x: len(x.get('text', '')),
            reverse=True
        )

        for entity in sorted_entities:
            original_text = entity.get('text', '')
            if not original_text or original_text in entity_replacements:
                continue

            if action == 'anonymize_restore':
                # Use numbered placeholder
                entity_type = entity.get('entity_type', 'unknown').lower()
                counter = entity_counters.get(entity_type, 0) + 1
                entity_counters[entity_type] = counter
                placeholder = f"__{entity_type}_{counter}__"
                entity_replacements[original_text] = placeholder
                restore_mapping[placeholder] = original_text
            else:
                # Use pre-computed anonymized_value
                anonymized_value = entity.get('anonymized_value')
                if anonymized_value is not None:
                    entity_replacements[original_text] = anonymized_value
                else:
                    entity_type = entity.get('entity_type', 'UNKNOWN').upper()
                    entity_replacements[original_text] = f"<{entity_type}>"

        # Apply replacements
        anonymized_content = content
        for original, replacement in sorted(
            entity_replacements.items(),
            key=lambda x: len(x[0]),
            reverse=True
        ):
            anonymized_content = anonymized_content.replace(original, replacement)

        if action == 'anonymize_restore':
            return anonymized_content, restore_mapping
        else:
            return anonymized_content, None

    def restore_content(
        self,
        content: str,
        mapping: Dict[str, str]
    ) -> str:
        """
        Restore placeholders in content to original values.

        Handles double underscore format: __email_1__ -> original value

        Args:
            content: Text containing placeholders like __email_1__
            mapping: Dict mapping placeholders to original values

        Returns:
            Text with placeholders restored to original values
        """
        if not mapping or not content:
            return content

        result = content

        # Sort by placeholder length (longest first) to avoid partial matches
        for placeholder, original in sorted(
            mapping.items(),
            key=lambda x: len(x[0]),
            reverse=True
        ):
            result = result.replace(placeholder, original)

        return result


# Singleton instance
_service_instance: Optional[UnifiedAnonymizationService] = None


def get_unified_anonymization_service() -> UnifiedAnonymizationService:
    """Get or create the UnifiedAnonymizationService singleton."""
    global _service_instance
    if _service_instance is None:
        _service_instance = UnifiedAnonymizationService()
    return _service_instance
