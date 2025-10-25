#!/usr/bin/env python3
"""
Detection service - high-concurrency guardrail detection API
Specialized for /v1/guardrails detection requests, optimized for high concurrency performance
"""
from fastapi import FastAPI, HTTPException, Depends, Security, Request
from contextlib import asynccontextmanager
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
import uvicorn
import os
import uuid
from pathlib import Path

from config import settings
from database.connection import init_db, create_detection_engine
from routers import detection_guardrails, dify_moderation
from services.async_logger import async_detection_logger
from utils.logger import setup_logger

# Set security verification (auto_error=False to allow manual handling)
security = HTTPBearer(auto_error=False)

# Import concurrent control middleware
from middleware.concurrent_limit_middleware import ConcurrentLimitMiddleware

class AuthContextMiddleware(BaseHTTPMiddleware):
    """Authentication context middleware - detection service version (simplified version)"""
    
    async def dispatch(self, request: Request, call_next):
        # Only handle detection API routes (including guardrails and dify moderation)
        if request.url.path.startswith('/v1/guardrails') or request.url.path.startswith('/v1/dify'):
            auth_header = request.headers.get('authorization')

            if auth_header:
                # Only accept "Bearer token" format
                if auth_header.startswith('Bearer '):
                    token = auth_header.split(' ')[1]
                else:
                    # Invalid format - must include Bearer prefix
                    token = None

                if token:
                    try:
                        auth_context = await self._get_auth_context(token)
                        request.state.auth_context = auth_context
                    except:
                        request.state.auth_context = None
                else:
                    request.state.auth_context = None
            else:
                request.state.auth_context = None

        response = await call_next(request)
        return response
    
    async def _get_auth_context(self, token: str):
        """Get authentication context (optimized version)"""
        from utils.auth_cache import auth_cache
        
        # Check cache
        cached_auth = auth_cache.get(token)
        if cached_auth:
            return cached_auth
        
        # Cache miss, verify token
        from database.connection import get_detection_db_session
        from database.models import Tenant
        from utils.user import get_user_by_api_key
        from utils.auth import verify_token
        
        db = get_detection_db_session()
        try:
            auth_context = None
            
            # JWT verification
            try:
                user_data = verify_token(token)
                raw_tenant_id = user_data.get('tenant_id') or user_data.get('sub')
                
                if isinstance(raw_tenant_id, str):
                    try:
                        tenant_uuid = uuid.UUID(raw_tenant_id)
                        user = db.query(Tenant).filter(Tenant.id == tenant_uuid).first()
                        if user:
                            auth_context = {
                                "type": "jwt", 
                                "data": {
                                    "tenant_id": str(user.id),
                                    "email": user.email
                                }
                            }
                    except ValueError:
                        pass
            except:
                # API key verification
                user = get_user_by_api_key(db, token)
                if user:
                    auth_context = {
                        "type": "api_key", 
                        "data": {
                            "tenant_id": str(user.id),
                            "email": user.email,
                            "api_key": user.api_key
                        }
                    }
            
            # Cache authentication result
            if auth_context:
                auth_cache.set(token, auth_context)
            
            return auth_context
            
        finally:
            db.close()

# Create FastAPI application
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup phase
    os.makedirs(settings.data_dir, exist_ok=True)
    os.makedirs(settings.log_dir, exist_ok=True)
    os.makedirs(settings.detection_log_dir, exist_ok=True)

    # Initialize database (detection service does not need full initialization)
    await init_db(minimal=True)

    # Start asynchronous logging service
    await async_detection_logger.start()

    logger.info(f"{settings.app_name} Detection Service started")
    logger.info(f"Detection API URL: {settings.guardrails_model_api_url}")
    logger.info("Detection service optimized for high concurrency")
    
    try:
        yield
    finally:
        # Shutdown phase
        await async_detection_logger.stop()
        from services.model_service import model_service
        await model_service.close()
        logger.info("Detection service shutdown completed")

app = FastAPI(
    title=f"{settings.app_name} - Detection Service",
    version=settings.app_version,
    description="OpenGuardrails detection service - high-concurrency detection API",
    docs_url="/docs" if settings.debug else None,
    redoc_url="/redoc" if settings.debug else None,
    lifespan=lifespan,
)

# Add concurrent control middleware (highest priority, added last)
app.add_middleware(ConcurrentLimitMiddleware, service_type="detection", max_concurrent=settings.detection_max_concurrent_requests)

# Add rate limit middleware
from middleware.rate_limit_middleware import RateLimitMiddleware
app.add_middleware(RateLimitMiddleware)

# Add authentication context middleware
app.add_middleware(AuthContextMiddleware)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)

# Set log
logger = setup_logger()

@app.get("/")
async def root():
    """Root path"""
    return {
        "name": f"{settings.app_name} - Detection Service",
        "version": settings.app_version,
        "status": "running",
        "service_type": "detection",
        "model_api_url": settings.guardrails_model_api_url,
        "workers": settings.detection_uvicorn_workers,
        "max_concurrent": settings.detection_max_concurrent_requests
    }

@app.get("/health")
async def health_check():
    """Health check"""
    return {
        "status": "healthy", 
        "version": settings.app_version,
        "service": "detection"
    }

# User authentication function (simplified version)
async def verify_user_auth(
    credentials: HTTPAuthorizationCredentials = Security(security),
    request: Request = None,
):
    """Verify user authentication (detection service专用)"""
    # Use middleware parsed authentication context
    if request is not None:
        auth_ctx = getattr(request.state, 'auth_context', None)
        if auth_ctx:
            return auth_ctx

    # If middleware didn't set auth_context, check if it's because of missing/invalid auth
    raise HTTPException(status_code=401, detail="Not authenticated")

# Register detection routes (special version)
app.include_router(detection_guardrails.router, prefix="/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(dify_moderation.router, prefix="/v1", dependencies=[Depends(verify_user_auth)])  # Dify API-based Extension

# Global exception handling
@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    logger.error(f"Detection service exception: {exc}")
    return JSONResponse(
        status_code=500,
        content={"detail": "Detection service internal error"}
    )

if __name__ == "__main__":
    uvicorn.run(
        "detection_service:app",
        host=settings.host,
        port=settings.detection_port,
        reload=settings.debug,
        log_level=settings.log_level.lower(),
        workers=settings.detection_uvicorn_workers if not settings.debug else 1
    )