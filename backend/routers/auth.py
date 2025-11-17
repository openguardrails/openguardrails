from datetime import timedelta, datetime
from fastapi import APIRouter, HTTPException, status, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel, EmailStr
from typing import Optional
from sqlalchemy.orm import Session

from utils.auth import authenticate_admin, create_access_token, verify_token, generate_reset_token, get_password_hash
from utils.email import send_password_reset_email, get_reset_token_expiry
from database.connection import get_db
from database.models import Tenant, PasswordResetToken
from config import settings

router = APIRouter(tags=["Authentication"])
security = HTTPBearer()

class DefaultLanguageResponse(BaseModel):
    default_language: str

class LoginRequest(BaseModel):
    username: str
    password: str

class LoginResponse(BaseModel):
    access_token: str
    token_type: str
    expires_in: int

class UserInfo(BaseModel):
    username: str
    role: str

@router.get("/default-language", response_model=DefaultLanguageResponse)
async def get_default_language():
    """
    Get default language configuration for the platform.
    This is a public endpoint that doesn't require authentication.
    Used by frontend to initialize language when there's no stored preference.
    """
    return DefaultLanguageResponse(default_language=settings.default_language)

@router.post("/login", response_model=LoginResponse)
async def login(login_data: LoginRequest, db: Session = Depends(get_db)):
    """Admin login"""
    if not authenticate_admin(login_data.username, login_data.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Get admin user tenant_id from database
    from database.models import Tenant
    admin_user = db.query(Tenant).filter(Tenant.email == login_data.username).first()
    if not admin_user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Admin user not found in database",
            headers={"WWW-Authenticate": "Bearer"},
        )

    access_token_expires = timedelta(minutes=settings.jwt_access_token_expire_minutes)
    access_token = create_access_token(
        data={
            "sub": login_data.username,
            "role": "admin",
            "tenant_id": str(admin_user.id),
            "email": admin_user.email
        },
        expires_delta=access_token_expires
    )

    return LoginResponse(
        access_token=access_token,
        token_type="bearer",
        expires_in=settings.jwt_access_token_expire_minutes * 60
    )

@router.get("/me", response_model=UserInfo)
async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    """Get current user information"""
    user_data = verify_token(credentials.credentials)
    # Compatible with different token structures: username field or sub field
    username = user_data.get("username") or user_data.get("sub")
    role = user_data.get("role", "admin")
    return UserInfo(username=username, role=role)

@router.post("/logout")
async def logout():
    """User logout (frontend handles token clearance)"""
    return {"message": "Successfully logged out"}

async def get_current_admin(credentials: HTTPAuthorizationCredentials = Depends(security)) -> dict:
    """Get current admin user (for dependency injection)"""
    return verify_token(credentials.credentials)

class ForgotPasswordRequest(BaseModel):
    email: EmailStr
    language: Optional[str] = 'en'

class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str

@router.post("/forgot-password")
async def forgot_password(request: ForgotPasswordRequest, db: Session = Depends(get_db)):
    """Request password reset - send reset email"""
    # Check if user exists
    user = db.query(Tenant).filter(Tenant.email == request.email).first()

    # For security reasons, always return success even if email doesn't exist
    # This prevents email enumeration attacks
    if not user:
        return {"message": "If the email exists, a password reset link will be sent"}

    # Generate reset token
    reset_token = generate_reset_token()
    expires_at = get_reset_token_expiry()

    # Save reset token to database
    password_reset = PasswordResetToken(
        email=request.email,
        reset_token=reset_token,
        expires_at=expires_at,
        is_used=False
    )
    db.add(password_reset)
    db.commit()

    # Build reset URL
    reset_url = f"{settings.frontend_url}/platform/reset-password?token={reset_token}"

    # Send reset email
    try:
        send_password_reset_email(request.email, reset_url, request.language)
    except Exception as e:
        # Log error but don't expose it to user
        print(f"Failed to send password reset email: {e}")
        # Still return success to prevent email enumeration

    return {"message": "If the email exists, a password reset link will be sent"}

@router.post("/reset-password")
async def reset_password(request: ResetPasswordRequest, db: Session = Depends(get_db)):
    """Reset password using token"""
    # Find valid reset token
    reset_record = db.query(PasswordResetToken).filter(
        PasswordResetToken.reset_token == request.token,
        PasswordResetToken.is_used == False,
        PasswordResetToken.expires_at > datetime.utcnow()
    ).first()

    if not reset_record:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired reset token"
        )

    # Find user
    user = db.query(Tenant).filter(Tenant.email == reset_record.email).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found"
        )

    # Validate new password strength
    from utils.validators import validate_password_strength
    password_validation = validate_password_strength(request.new_password)

    if not password_validation["is_valid"]:
        error_messages = ", ".join(password_validation["errors"])
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Password does not meet security requirements: {error_messages}"
        )

    # Update password
    user.password_hash = get_password_hash(request.new_password)

    # Mark token as used
    reset_record.is_used = True

    db.commit()

    return {"message": "Password reset successful"}

@router.post("/verify-reset-token")
async def verify_reset_token(token: str, db: Session = Depends(get_db)):
    """Verify if reset token is valid"""
    reset_record = db.query(PasswordResetToken).filter(
        PasswordResetToken.reset_token == token,
        PasswordResetToken.is_used == False,
        PasswordResetToken.expires_at > datetime.utcnow()
    ).first()

    if not reset_record:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired reset token"
        )

    return {"valid": True, "email": reset_record.email}