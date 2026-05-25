"""
Internationalization tool module
Provide multi-language support functionality
"""
from typing import Dict, Any, Optional

# Translation dictionary
TRANSLATIONS = {
    'zh': {
        'ban_reason_template': '在 {time_window} 分钟内触发 {trigger_count} 次{risk_level}风险',
        'risk_levels': {
            'low_risk': '低',
            'medium_risk': '中',
            'high_risk': '高'
        }
    },
    'en': {
        'ban_reason_template': 'Triggered {trigger_count} {risk_level} risk(s) within {time_window} minutes',
        'risk_levels': {
            'low_risk': 'low',
            'medium_risk': 'medium', 
            'high_risk': 'high'
        }
    }
}

def get_language_from_request(request=None, tenant_id: Optional[str] = None) -> str:
    """
    Get language setting from request
    
    Args:
        request: FastAPI Request object
        tenant_id: Tenant ID (can be used to get tenant language preference)
        
    Returns:
        Language code, default is 'zh'
    """
    # Priority:
    # 1. Accept-Language in request header
    # 2. Tenant setting (if any)
    # 3. Default Chinese
    
    if request:
        # Check Accept-Language header
        accept_language = request.headers.get('accept-language', '')
        if 'en' in accept_language.lower():
            return 'en'
    
    # Default return Chinese
    return 'zh'

def translate(key: str, language: str = 'zh', **kwargs) -> str:
    """
    Translate specified key value
    
    Args:
        key: Translation key
        language: Language code
        **kwargs: Template parameters
        
    Returns:
        Translated text
    """
    # Get translation for corresponding language
    lang_dict = TRANSLATIONS.get(language, TRANSLATIONS['zh'])
    
    # Get translated text
    text = lang_dict.get(key, key)
    
    # If there are parameters, format them
    if kwargs:
        try:
            return text.format(**kwargs)
        except (KeyError, ValueError):
            # If formatting fails, return original text
            return text
    
    return text

def get_risk_level_text(risk_level: str, language: str = 'zh') -> str:
    """
    Get localized text for risk level
    
    Args:
        risk_level: Risk level (e.g. 'high_risk')
        language: Language code
        
    Returns:
        Localized risk level text
    """
    lang_dict = TRANSLATIONS.get(language, TRANSLATIONS['zh'])
    risk_levels = lang_dict.get('risk_levels', {})
    return risk_levels.get(risk_level, risk_level)

def format_ban_reason(time_window: int, trigger_count: int, risk_level: str, language: str = 'zh') -> str:
    """
    Format ban reason
    
    Args:
        time_window: Time window (minutes)
        trigger_count: Trigger count
        risk_level: Risk level
        language: Language code
        
    Returns:
        Formatted ban reason
    """
    # Get localized text for risk level
    risk_level_text = get_risk_level_text(risk_level, language)
    
    # Format ban reason
    return translate(
        'ban_reason_template',
        language=language,
        time_window=time_window,
        trigger_count=trigger_count,
        risk_level=risk_level_text
    )
