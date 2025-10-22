"""
Internationalization (i18n) utility for loading translations
"""
import json
import os
from typing import Dict, Any
from pathlib import Path

# Cache for loaded translations
_translations_cache: Dict[str, Dict[str, Any]] = {}

def get_i18n_path() -> Path:
    """Get the path to i18n directory"""
    # Get the backend directory path
    backend_dir = Path(__file__).parent.parent
    return backend_dir / "i18n"

def load_translations(language: str) -> Dict[str, Any]:
    """
    Load translations for the given language

    Args:
        language: Language code ('en', 'zh', etc.)

    Returns:
        Dictionary containing translations
    """
    # Check cache first
    if language in _translations_cache:
        return _translations_cache[language]

    # Default to English if language not supported
    if language not in ['en', 'zh']:
        language = 'en'

    i18n_path = get_i18n_path()
    file_path = i18n_path / f"{language}.json"

    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            translations = json.load(f)
            _translations_cache[language] = translations
            return translations
    except FileNotFoundError:
        # Fall back to English if the language file doesn't exist
        if language != 'en':
            return load_translations('en')
        raise Exception(f"Translation file not found: {file_path}")
    except json.JSONDecodeError as e:
        raise Exception(f"Invalid JSON in translation file {file_path}: {e}")

def get_translation(language: str, *keys: str) -> str:
    """
    Get a specific translation by nested keys

    Args:
        language: Language code ('en', 'zh', etc.)
        *keys: Nested keys to access the translation (e.g., 'email', 'verification', 'subject')

    Returns:
        The translated string

    Example:
        get_translation('en', 'email', 'verification', 'subject')
        # Returns: "OpenGuardrails - Email Verification Code"
    """
    translations = load_translations(language)

    # Navigate through nested keys
    current = translations
    for key in keys:
        if isinstance(current, dict) and key in current:
            current = current[key]
        else:
            # Fall back to English if key not found
            if language != 'en':
                return get_translation('en', *keys)
            raise KeyError(f"Translation key not found: {'.'.join(keys)}")

    return current
