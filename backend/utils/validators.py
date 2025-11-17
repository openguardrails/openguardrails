import re
from typing import List, Optional
from pydantic import BaseModel, validator

class MessageValidator(BaseModel):
    """Message validator"""
    role: str
    content: str
    
    @validator('role')
    def validate_role(cls, v):
        if v not in ['user', 'system', 'assistant']:
            raise ValueError('role must be one of: user, system, assistant')
        return v
    
    @validator('content')
    def validate_content(cls, v):
        if not v or not v.strip():
            raise ValueError('content cannot be empty')
        if len(v) > 1000000:  # Limit content length
            raise ValueError('content too long (max 1000000 characters)')
        return v.strip()

def validate_api_key(api_key: str) -> bool:
    """Validate API key format"""
    if not api_key:
        return False
    
    # Must start with sk-xxai-, and the length is reasonable
    if not api_key.startswith('sk-xxai-'):
        return False
    if len(api_key) < 20 or len(api_key) > 128:
        return False
    
    return True

def validate_email(email: str) -> bool:
    """Validate email format"""
    pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    return bool(re.match(pattern, email))

def sanitize_input(text: str) -> str:
    """Clean input text"""
    if not text:
        return ""
    
    # Remove potential malicious characters
    text = re.sub(r'[<>"\']', '', text)
    
    # Limit length
    if len(text) > 10000:
        text = text[:10000]
    
    return text.strip()

def clean_null_characters(text: str) -> str:
    """Clean NUL characters in the string, prevent database insertion error"""
    if not text:
        return text
    
    # Remove NUL characters (0x00) and other control characters
    # Keep common control characters like \n, \r, \t
    import re
    # Remove NUL characters
    text = text.replace('\x00', '')
    # Remove other control characters that may cause problems, but keep common ones like \n, \r, \t
    text = re.sub(r'[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]', '', text)
    
    return text

def clean_detection_data(data: dict) -> dict:
    """Recursively clean NUL characters in detection data"""
    if isinstance(data, dict):
        return {key: clean_detection_data(value) for key, value in data.items()}
    elif isinstance(data, list):
        return [clean_detection_data(item) for item in data]
    elif isinstance(data, str):
        return clean_null_characters(data)
    else:
        return data

def extract_keywords(text: str) -> List[str]:
    """Extract keywords from text"""
    # Simple keyword extraction, can be optimized later
    words = re.findall(r'\w+', text.lower())
    return [word for word in words if len(word) > 2]

def validate_password_strength(password: str) -> dict:
    """
    Validate password strength

    Requirements:
    - At least 8 characters long
    - Contains uppercase letters
    - Contains lowercase letters
    - Contains numbers

    Returns:
        dict with keys:
        - is_valid: bool
        - errors: list of error messages
        - strength_score: int (0-100)
    """
    errors = []
    strength_score = 0

    # Length check
    if len(password) < 8:
        errors.append("Password must be at least 8 characters long")
    else:
        strength_score += 25

    # Uppercase check
    if not re.search(r'[A-Z]', password):
        errors.append("Password must contain at least one uppercase letter")
    else:
        strength_score += 25

    # Lowercase check
    if not re.search(r'[a-z]', password):
        errors.append("Password must contain at least one lowercase letter")
    else:
        strength_score += 25

    # Number check
    if not re.search(r'\d', password):
        errors.append("Password must contain at least one number")
    else:
        strength_score += 25

    # Bonus points for special characters
    if re.search(r'[!@#$%^&*(),.?":{}|<>]', password):
        strength_score = min(100, strength_score + 10)

    # Bonus points for longer passwords
    if len(password) >= 12:
        strength_score = min(100, strength_score + 10)

    is_valid = len(errors) == 0

    return {
        "is_valid": is_valid,
        "errors": errors,
        "strength_score": strength_score
    }

def is_password_strong(password: str) -> bool:
    """Simple boolean check for password strength"""
    result = validate_password_strength(password)
    return result["is_valid"]