from datetime import datetime, timedelta
from typing import Optional
from fastapi import HTTPException, status
from jose import JWTError, jwt
from passlib.context import CryptContext
from config import settings
import secrets
import string

# Password encryption context
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify password"""
    return pwd_context.verify(plain_password, hashed_password)

def check_existing_password_strength(plain_password: str, hashed_password: str) -> bool:
    """
    Check if existing user's password meets current strength requirements
    This function verifies the password first, then checks its strength
    """
    # First verify the password is correct
    if not verify_password(plain_password, hashed_password):
        return False

    # Then check if it meets current strength requirements
    from utils.validators import is_password_strong
    return is_password_strong(plain_password)

def get_password_hash(password: str) -> str:
    """Get password hash"""
    return pwd_context.hash(password)

def generate_api_key() -> str:
    """Generate API key"""
    # Generate 64-bit character API key, format: sk-xxai-[52 random characters]
    prefix = "sk-xxai-"
    key_length = 52
    characters = string.ascii_letters + string.digits
    random_part = ''.join(secrets.choice(characters) for _ in range(key_length))
    return prefix + random_part

def generate_reset_token() -> str:
    """Generate password reset token"""
    # Generate 64-character secure random token
    return secrets.token_urlsafe(48)[:64]

def authenticate_admin(username: str, password: str) -> bool:
    """Verify admin account"""
    if username != settings.super_admin_username:
        return False
    if password != settings.super_admin_password:
        return False
    return True

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """Create access token"""
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=settings.jwt_access_token_expire_minutes)
    
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)
    return encoded_jwt

def verify_token(token: str) -> dict:
    """Verify token"""
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        subject: str = payload.get("sub")
        role: str = payload.get("role", "user")

        if subject is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication credentials",
                headers={"WWW-Authenticate": "Bearer"},
            )

        # Admin token retains original structure (with tenant_id if available)
        if role == "admin":
            result = {"username": subject, "role": role}
            # Include tenant_id if present in payload (for new admin tokens)
            tenant_id = payload.get("tenant_id")
            if tenant_id:
                result["tenant_id"] = tenant_id
            email = payload.get("email")
            if email:
                result["email"] = email
            return result

        # Ordinary tenant: ensure return contains tenant_id (UUID string), compatible with old token with only sub
        tenant_id = payload.get("tenant_id") or payload.get("user_id")  # 兼容旧字段名user_id
        if tenant_id is None:
            # Compatible with old token: use sub as tenant_id (string)
            tenant_id = subject

        return {
            "tenant_id": tenant_id,
            "user_id": tenant_id,  # Preserve backward compatibility
            "sub": subject,
            "email": payload.get("email"),
            "role": role,
            "is_super_admin": payload.get("is_super_admin", False),
        }
            
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )