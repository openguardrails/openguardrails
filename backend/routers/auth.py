from datetime import timedelta
from fastapi import APIRouter, HTTPException, status, Depends
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from typing import Optional

from utils.auth import authenticate_admin, create_access_token, verify_token
from config import settings

router = APIRouter(tags=["Authentication"])
security = HTTPBearer()

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

@router.post("/login", response_model=LoginResponse)
async def login(login_data: LoginRequest):
    """Admin login"""
    if not authenticate_admin(login_data.username, login_data.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    access_token_expires = timedelta(minutes=settings.jwt_access_token_expire_minutes)
    access_token = create_access_token(
        data={"sub": login_data.username, "role": "admin"},
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