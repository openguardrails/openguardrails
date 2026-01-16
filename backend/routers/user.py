from datetime import timedelta, datetime
from fastapi import APIRouter, HTTPException, status, Depends, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, EmailStr
from sqlalchemy.orm import Session
from typing import Optional

from database.connection import get_admin_db
from database.models import Tenant, EmailVerification
from utils.auth import create_access_token, verify_token, verify_password, get_password_hash
from utils.user import create_user, verify_user_email, regenerate_api_key, get_user_by_email, get_user_by_api_key, record_login_attempt, check_login_rate_limit
from utils.email import send_verification_email, generate_verification_code, get_verification_expiry
from config import settings
from services.admin_service import admin_service

router = APIRouter(tags=["User Management"])
security = HTTPBearer()

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    language: Optional[str] = 'en'  # Default to English

class VerifyEmailRequest(BaseModel):
    email: EmailStr
    verification_code: str

class ResendCodeRequest(BaseModel):
    email: EmailStr
    language: Optional[str] = 'en'  # Default to English

class LoginRequest(BaseModel):
    email: EmailStr
    password: str
    language: Optional[str] = None  # Optional language preference

class LoginResponse(BaseModel):
    access_token: str
    token_type: str
    expires_in: int
    api_key: str
    tenant_id: str  # Changed to string UUID
    is_super_admin: bool
    requires_password_change: bool = False
    password_message: Optional[str] = None

class UserInfo(BaseModel):
    id: str  # Changed to string UUID
    email: str
    api_key: str
    model_api_key: Optional[str] = None  # Direct Model Access API Key (for private deployment)
    is_active: bool
    is_verified: bool
    is_super_admin: bool
    rate_limit: int  # Speed limit (requests per second, 0 means unlimited, default is 1)
    language: str  # User language preference

class ApiKeyResponse(BaseModel):
    api_key: str

class ModelApiKeyResponse(BaseModel):
    model_api_key: str

def get_current_user_from_token(credentials: HTTPAuthorizationCredentials, db: Session) -> Tenant:
    """Get current tenant from JWT token"""
    try:
        tenant_data = verify_token(credentials.credentials)
        tenant_id = tenant_data.get('tenant_id') or tenant_data.get('tenant_id') or tenant_data.get('sub')

        if not tenant_id:
            raise HTTPException(status_code=401, detail="Invalid token: tenant ID not found")

        # Ensure tenant_id is a UUID object or string
        if isinstance(tenant_id, str):
            try:
                import uuid
                tenant_id = uuid.UUID(tenant_id)
            except ValueError:
                raise HTTPException(status_code=401, detail="Invalid tenant ID format")

        tenant = db.query(Tenant).filter(Tenant.id == tenant_id).first()
        if not tenant or not tenant.is_active or not tenant.is_verified:
            raise HTTPException(status_code=401, detail="Tenant not found, inactive, or not verified")

        return tenant
    except Exception as e:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

@router.post("/register")
async def register_user(register_data: RegisterRequest, db: Session = Depends(get_admin_db)):
    """Tenant registration"""
    # Validate enterprise email (reject personal emails)
    from utils.validators import validate_enterprise_email
    email_validation = validate_enterprise_email(register_data.email)
    if not email_validation["is_valid"]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=email_validation["error"]
        )

    # Check if email already exists
    existing_tenant = get_user_by_email(db, register_data.email)
    if existing_tenant:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered"
        )

    # Create tenant
    try:
        tenant = create_user(db, register_data.email, register_data.password)
    except ValueError as e:
        # Handle password validation errors gracefully
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create tenant"
        )
    
    # Generate verification code and send email
    verification_code = generate_verification_code()
    verification_expiry = get_verification_expiry()
    
    # Save verification code to database
    email_verification = EmailVerification(
        email=register_data.email,
        verification_code=verification_code,
        expires_at=verification_expiry
    )
    db.add(email_verification)
    db.commit()
    
    # Send verification email with language preference
    try:
        if not send_verification_email(register_data.email, verification_code, register_data.language):
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to send verification email"
            )
    except Exception:
        # If email sending fails, still return success but prompt user to contact administrator
        return {"message": "Registration successful. Please contact administrator to verify your account."}

    return {"message": "Registration successful. Please check your email for verification code."}

@router.post("/verify-email")
async def verify_email(verify_data: VerifyEmailRequest, db: Session = Depends(get_admin_db)):
    """Verify email"""
    if not verify_user_email(db, verify_data.email, verify_data.verification_code):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired verification code"
        )
    
    return {"message": "Email verified successfully. You can now login."}

@router.post("/resend-verification-code")
async def resend_verification_code(resend_data: ResendCodeRequest, db: Session = Depends(get_admin_db)):
    """Resend verification code"""
    try:
        # Check if tenant exists and is not verified
        tenant = get_user_by_email(db, resend_data.email)
        if not tenant:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Tenant not found"
            )

        if tenant.is_verified:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email already verified"
            )
        
        # Generate new verification code
        verification_code = generate_verification_code()
        verification_expiry = get_verification_expiry()
        
        # Save new verification code
        email_verification = EmailVerification(
            email=resend_data.email,
            verification_code=verification_code,
            expires_at=verification_expiry
        )
        db.add(email_verification)
        db.commit()
        
        # Send verification email with language preference
        try:
            if not send_verification_email(resend_data.email, verification_code, resend_data.language):
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Failed to send verification email"
                )
        except Exception as e:
            return {"message": "Verification code generated. Please contact administrator if you don't receive the email."}

        return {"message": "Verification code resent successfully. Please check your email."}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to resend verification code"
        )

@router.post("/login", response_model=LoginResponse)
async def login_user(login_data: LoginRequest, request: Request, db: Session = Depends(get_admin_db)):
    """Tenant login"""
    # Get client information
    client_ip = request.client.host if request.client else "unknown"
    user_agent = request.headers.get("user-agent", "")

    # Check login rate limit
    if not check_login_rate_limit(db, login_data.email, client_ip):
        record_login_attempt(db, login_data.email, client_ip, user_agent, False)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many login attempts. Please try again later."
        )

    # Unified tenant login
    tenant = get_user_by_email(db, login_data.email)
    if not tenant:
        record_login_attempt(db, login_data.email, client_ip, user_agent, False)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials"
        )

    if not verify_password(login_data.password, tenant.password_hash):
        record_login_attempt(db, login_data.email, client_ip, user_agent, False)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid credentials"
        )

    # Check if account is active and email is verified
    if not tenant.is_active or not tenant.is_verified:
        record_login_attempt(db, login_data.email, client_ip, user_agent, False)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account not verified. Please check your email address and complete verification."
        )

    # Check if password meets current strength requirements
    from utils.auth import check_existing_password_strength
    requires_password_change = not check_existing_password_strength(login_data.password, tenant.password_hash)
    password_message = "Your password does not meet current security requirements. Please update it to a stronger password." if requires_password_change else None

    # Update user language preference if provided
    if login_data.language and login_data.language in ['en', 'zh']:
        tenant.language = login_data.language
        db.commit()

    # Record successful login
    record_login_attempt(db, login_data.email, client_ip, user_agent, True)

    access_token_expires = timedelta(minutes=settings.jwt_access_token_expire_minutes)
    is_super_admin = admin_service.is_super_admin(tenant)
    access_token = create_access_token(
        data={"sub": str(tenant.id), "email": tenant.email, "tenant_id": str(tenant.id), "user_id": str(tenant.id), "is_super_admin": is_super_admin},
        expires_delta=access_token_expires
    )

    return LoginResponse(
        access_token=access_token,
        token_type="bearer",
        expires_in=settings.jwt_access_token_expire_minutes * 60,
        api_key=tenant.api_key,
        tenant_id=str(tenant.id),
        is_super_admin=is_super_admin,
        requires_password_change=requires_password_change,
        password_message=password_message
    )

@router.get("/me", response_model=UserInfo)
async def get_current_user_info(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_admin_db)
):
    """Get current tenant information"""
    tenant = get_current_user_from_token(credentials, db)

    # Get tenant speed limit configuration
    try:
        from services.rate_limiter import RateLimitService
        from utils.logger import setup_logger
        logger = setup_logger()

        rate_limit_service = RateLimitService(db)
        rate_limit_config = rate_limit_service.get_user_rate_limit(str(tenant.id))
        # If there is a configuration and it is active, use the configuration value; otherwise use default value 10 RPS
        rate_limit = rate_limit_config.requests_per_second if rate_limit_config and rate_limit_config.is_active else 10
        logger.info(f"Tenant {tenant.email} speed limit: {rate_limit} (configuration exists: {rate_limit_config is not None})")
    except Exception as e:
        from utils.logger import setup_logger
        logger = setup_logger()
        logger.error(f"Get tenant speed limit failed: {e}")
        rate_limit = 10  # Default value

    return UserInfo(
        id=str(tenant.id),  # Convert to string format
        email=tenant.email,
        api_key=tenant.api_key,
        model_api_key=tenant.model_api_key,  # Include Model API Key
        is_active=tenant.is_active,
        is_verified=tenant.is_verified,
        is_super_admin=admin_service.is_super_admin(tenant),
        rate_limit=rate_limit,
        language=tenant.language
    )

@router.post("/regenerate-api-key", response_model=ApiKeyResponse)
async def regenerate_user_api_key(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_admin_db)
):
    """Regenerate API key"""
    tenant = get_current_user_from_token(credentials, db)

    new_api_key = regenerate_api_key(db, tenant.id)
    if not new_api_key:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tenant not found"
        )

    return ApiKeyResponse(api_key=new_api_key)

@router.post("/regenerate-model-api-key", response_model=ModelApiKeyResponse)
async def regenerate_model_api_key(
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_admin_db)
):
    """Regenerate Model API Key for Direct Model Access"""
    tenant = get_current_user_from_token(credentials, db)

    # Generate new model API key with format: sk-xxai-model-{49 random chars}
    # Total: 15 (prefix) + 49 (random) = 64 chars (matches DB VARCHAR(64))
    import secrets
    random_part = secrets.token_hex(24)[:49]  # Generate 48 hex chars, take first 49
    new_model_api_key = f"sk-xxai-model-{random_part}"

    # Update tenant's model API key
    tenant.model_api_key = new_model_api_key
    db.commit()

    return ModelApiKeyResponse(model_api_key=new_model_api_key)

@router.post("/logout")
async def logout_user():
    """Tenant logout (front-end handles token clearing)"""
    return {"message": "Successfully logged out"}

class UpdateLanguageRequest(BaseModel):
    language: str

class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

@router.post("/change-password", response_model=dict)
async def change_password(
    password_data: ChangePasswordRequest,
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_admin_db)
):
    """Change current user's password"""
    # Get current user
    tenant = get_current_user_from_token(credentials, db)

    # Verify current password
    from utils.auth import verify_password
    if not verify_password(password_data.current_password, tenant.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect"
        )

    # Validate new password strength
    from utils.validators import validate_password_strength
    password_validation = validate_password_strength(password_data.new_password)

    if not password_validation["is_valid"]:
        error_messages = ", ".join(password_validation["errors"])
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"New password does not meet security requirements: {error_messages}"
        )

    # Update password
    tenant.password_hash = get_password_hash(password_data.new_password)
    db.commit()

    return {
        "status": "success",
        "message": "Password changed successfully"
    }

@router.put("/language", response_model=dict)
async def update_user_language(
    language_data: UpdateLanguageRequest,
    credentials: HTTPAuthorizationCredentials = Depends(security),
    db: Session = Depends(get_admin_db)
):
    """Update user language preference"""
    # Validate language
    if language_data.language not in ['en', 'zh']:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid language. Must be 'en' or 'zh'"
        )
    
    # Get current user
    tenant = get_current_user_from_token(credentials, db)
    
    # Update language
    tenant.language = language_data.language
    db.commit()
    
    return {
        "status": "success",
        "message": "Language updated successfully",
        "language": language_data.language
    }