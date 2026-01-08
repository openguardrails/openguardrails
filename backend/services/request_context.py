"""
Request context service for storing anonymization mapping within a request lifecycle.

This module provides a context-based storage mechanism for anonymization mappings
that allows data to be passed from input processing to output processing
without using external storage like Redis.
"""

from contextvars import ContextVar
from typing import Dict, Optional
import logging

logger = logging.getLogger(__name__)

# Request-scoped context for storing anonymization mapping
_anonymization_mapping: ContextVar[Optional[Dict[str, str]]] = ContextVar(
    'anonymization_mapping', default=None
)

# Request-scoped context for storing entity type counters (for numbered placeholders)
_entity_counters: ContextVar[Optional[Dict[str, int]]] = ContextVar(
    'entity_counters', default=None
)


class AnonymizationContext:
    """
    Context manager for storing anonymization mapping within a request.

    The mapping stores placeholder -> original value pairs, e.g.:
    {
        "[email_1]": "alice@gmail.com",
        "[email_2]": "bob@qq.com",
        "[phone_1]": "1382",  # Middle 4 digits
    }

    Usage:
        # In input processing
        AnonymizationContext.set_mapping({
            "[email_1]": "alice@gmail.com"
        })

        # In output processing
        mapping = AnonymizationContext.get_mapping()
        restored_text = restore_placeholders(output_text, mapping)

        # At request end
        AnonymizationContext.clear()
    """

    @staticmethod
    def set_mapping(mapping: Dict[str, str]) -> None:
        """
        Store or update mapping for current request.

        Args:
            mapping: Dict mapping placeholders to original values
        """
        current = _anonymization_mapping.get() or {}
        current.update(mapping)
        _anonymization_mapping.set(current)
        logger.debug(f"AnonymizationContext: Updated mapping with {len(mapping)} entries, total: {len(current)}")

    @staticmethod
    def get_mapping() -> Dict[str, str]:
        """
        Get mapping for current request.

        Returns:
            Dict mapping placeholders to original values, or empty dict if none set
        """
        return _anonymization_mapping.get() or {}

    @staticmethod
    def has_mapping() -> bool:
        """
        Check if there is any mapping stored.

        Returns:
            True if mapping exists and is non-empty
        """
        mapping = _anonymization_mapping.get()
        return mapping is not None and len(mapping) > 0

    @staticmethod
    def clear() -> None:
        """Clear mapping at end of request."""
        _anonymization_mapping.set(None)
        _entity_counters.set(None)
        logger.debug("AnonymizationContext: Cleared all mappings and counters")

    @staticmethod
    def get_next_counter(entity_type: str) -> int:
        """
        Get the next counter value for an entity type.

        Used for generating numbered placeholders like [email_1], [email_2].

        Args:
            entity_type: The entity type code (e.g., "email", "phone")

        Returns:
            The next counter value (starts from 1)
        """
        counters = _entity_counters.get() or {}
        current = counters.get(entity_type, 0)
        next_val = current + 1
        counters[entity_type] = next_val
        _entity_counters.set(counters)
        return next_val

    @staticmethod
    def get_counters() -> Dict[str, int]:
        """
        Get all entity type counters.

        Returns:
            Dict mapping entity types to their current counter values
        """
        return _entity_counters.get() or {}


def restore_placeholders(text: str, mapping: Dict[str, str] = None) -> str:
    """
    Restore placeholders in text to original values.

    Args:
        text: Text containing placeholders like [email_1]
        mapping: Optional mapping dict. If not provided, uses context mapping.

    Returns:
        Text with placeholders restored to original values
    """
    if mapping is None:
        mapping = AnonymizationContext.get_mapping()

    if not mapping:
        return text

    result = text
    for placeholder, original in mapping.items():
        result = result.replace(placeholder, original)

    return result
