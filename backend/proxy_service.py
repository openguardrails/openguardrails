#!/usr/bin/env python3
"""
Reverse proxy service - OpenAI compatible proxy guardrails service
Provide complete OpenAI API compatible layer, support multi-model configuration and security detection
"""
from fastapi import FastAPI, HTTPException, Depends, Security, Request
from contextlib import asynccontextmanager
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.gzip import GZipMiddleware
import uvicorn
import os
import uuid
from pathlib import Path
import asyncio

from config import settings
# Import complete proxy service implementation
from routers import proxy_api, gateway_integration_api, model_direct_access
from services.async_logger import async_detection_logger
from utils.logger import setup_logger

# Set security verification (auto_error=False to allow manual handling)
security = HTTPBearer(auto_error=False)

# Import concurrent control middleware
from middleware.concurrent_limit_middleware import ConcurrentLimitMiddleware

class AuthContextMiddleware(BaseHTTPMiddleware):
    """Authentication context middleware - proxy service version"""

    async def dispatch(self, request: Request, call_next):
        # Handle OpenAI compatible API routes
        if request.url.path.startswith('/v1/'):
            auth_header = request.headers.get('authorization')

            if auth_header:
                # Automatically handle both "Bearer token" and direct "token" formats
                if auth_header.startswith('Bearer '):
                    token = auth_header.split(' ')[1]
                elif auth_header.startswith('sk-xxai-'):
                    # Direct API key without "Bearer " prefix
                    token = auth_header
                else:
                    # Invalid format
                    token = None

                if token:
                    try:
                        # Pass request to access X-OG-Application-ID header for auto-discovery
                        auth_context = await self._get_auth_context(token, request)
                        request.state.auth_context = auth_context
                    except:
                        request.state.auth_context = None
                else:
                    request.state.auth_context = None
            else:
                request.state.auth_context = None

        response = await call_next(request)
        return response

    async def _get_auth_context(self, token: str, request: Request = None):
        """Get authentication context (proxy service with application support and auto-discovery)"""
        from utils.auth_cache import auth_cache
        from utils.auth import verify_token

        # Get external app ID from header for auto-discovery (don't cache with external app ID as it creates unique apps)
        external_app_id = request.headers.get('X-OG-Application-ID') if request else None

        # Check cache (only if no external app ID - external app ID requests create new apps)
        if not external_app_id:
            cached_auth = auth_cache.get(token)
            if cached_auth:
                return cached_auth

        auth_context = None

        try:
            # First try JWT verification
            user_data = verify_token(token)
            raw_tenant_id = user_data.get('tenant_id') or user_data.get('sub')

            if isinstance(raw_tenant_id, str):
                try:
                    tenant_uuid = uuid.UUID(raw_tenant_id)

                    # For JWT auth, get the first active application
                    from database.connection import get_admin_db_session
                    from database.models import Application

                    db = get_admin_db_session()
                    try:
                        first_app = db.query(Application).filter(
                            Application.tenant_id == tenant_uuid,
                            Application.is_active == True
                        ).first()

                        auth_context = {
                            "type": "jwt",
                            "data": {
                                "tenant_id": raw_tenant_id,
                                "email": user_data.get('email', 'unknown'),
                                "application_id": str(first_app.id) if first_app else None,
                                "application_name": first_app.name if first_app else None
                            }
                        }
                    finally:
                        db.close()
                except ValueError:
                    pass
        except:
            # JWT verification failed, try API key verification
            try:
                from database.connection import get_admin_db_session
                from database.models import Application
                from utils.user import get_user_by_api_key, get_application_by_api_key, get_or_create_application_by_external_id

                db = get_admin_db_session()
                try:
                    # API key verification
                    # When X-OG-Application-ID header is present, prioritize tenant API key for auto-discovery
                    # This allows the same key to work both ways: as application key (normal) or tenant key (with header)
                    if external_app_id:
                        # Auto-discovery mode: check tenant API key FIRST
                        user = get_user_by_api_key(db, token)
                        if user:
                            # Auto-discovery mode: get or create application by external app ID
                            app_info = get_or_create_application_by_external_id(db, str(user.id), external_app_id)
                            if app_info:
                                auth_context = {
                                    "type": "tenant_api_key_with_consumer",
                                    "data": {
                                        "tenant_id": str(user.id),
                                        "email": user.email,
                                        "api_key": user.api_key,
                                        "application_id": app_info["application_id"],
                                        "application_name": app_info["application_name"],
                                        "is_auto_discovered": app_info["is_new"],
                                        "external_app_id": external_app_id
                                    }
                                }
                    else:
                        # Normal mode: check application API key first (new multi-application support)
                        app_data = get_application_by_api_key(db, token)
                        if app_data:
                            auth_context = {
                                "type": "api_key",
                                "data": {
                                    "tenant_id": app_data["tenant_id"],
                                    "email": app_data["tenant_email"],
                                    "application_id": app_data["application_id"],
                                    "application_name": app_data["application_name"],
                                    "api_key": app_data["api_key"]
                                }
                            }
                        else:
                            # Fallback to tenant API key (backward compatible)
                            user = get_user_by_api_key(db, token)
                            if user:
                                # No external app ID - get first active application (backward compatible)
                                first_app = db.query(Application).filter(
                                    Application.tenant_id == user.id,
                                    Application.is_active == True
                                ).first()

                                auth_context = {
                                    "type": "api_key_legacy",
                                    "data": {
                                        "tenant_id": str(user.id),
                                        "email": user.email,
                                        "api_key": user.api_key,
                                        "application_id": str(first_app.id) if first_app else None,
                                        "application_name": first_app.name if first_app else None
                                    }
                                }
                finally:
                    db.close()
            except Exception as e:
                logger.error(f"API key verification failed: {e}")

        # If all verification fails, do not create anonymous user context
        # This will trigger a 401 error, which is expected behavior for the API

        # Cache authentication result (only if no external app ID - external app ID creates unique contexts)
        if auth_context and not external_app_id:
            auth_cache.set(token, auth_context)

        return auth_context

# Create FastAPI application
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup phase
    os.makedirs(settings.data_dir, exist_ok=True)
    os.makedirs(settings.log_dir, exist_ok=True)
    os.makedirs(settings.detection_log_dir, exist_ok=True)

    # Proxy service does not initialize database, focus on high concurrency proxy functionality

    # Start asynchronous log service
    await async_detection_logger.start()

    logger.info(f"{settings.app_name} Proxy Service started")
    logger.info(f"Proxy API running on port {settings.proxy_port}")
    logger.info("OpenAI-compatible proxy service with guardrails protection")
    
    try:
        yield
    finally:
        # Shutdown phase
        await async_detection_logger.stop()
        from services.model_service import model_service
        await model_service.close()
        
        # Close HTTP client connection pool
        from services.proxy_service import proxy_service
        await proxy_service.close()
        
        logger.info("Proxy service shutdown completed")

app = FastAPI(
    title=f"{settings.app_name} - Proxy Service",
    version=settings.app_version,
    description="OpenGuardrails proxy service - OpenAI compatible reverse proxy",
    docs_url="/docs" if settings.debug else None,
    redoc_url="/redoc" if settings.debug else None,
    lifespan=lifespan,
)

# Add concurrent control middleware (highest priority, last added)
app.add_middleware(ConcurrentLimitMiddleware, service_type="proxy", max_concurrent=settings.proxy_max_concurrent_requests)

# Performance optimization middleware
app.add_middleware(GZipMiddleware, minimum_size=1000)

# Add rate limiting middleware
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
        "name": f"{settings.app_name} - Proxy Service",
        "version": settings.app_version,
        "status": "running",
        "service_type": "proxy",
        "api_compatibility": "OpenAI v1",
        "supported_endpoints": [
            "POST /v1/chat/completions",
            "POST /v1/completions", 
            "GET /v1/models",
            "POST /v1/model/chat/completions",
            "POST /v1/model/embeddings"
        ],
        "base_url": f"http://localhost:{settings.proxy_port}",
        "workers": settings.proxy_uvicorn_workers,
        "max_concurrent": settings.proxy_max_concurrent_requests
    }

@app.get("/health")
async def health_check():
    """Health check"""
    return {
        "status": "healthy", 
        "version": settings.app_version,
        "service": "proxy"
    }

# User authentication function
async def verify_user_auth(
    credentials: HTTPAuthorizationCredentials = Security(security),
    request: Request = None,
):
    """Verify user authentication (proxy service专用)"""
    # Use middleware to parse authentication context
    if request is not None:
        auth_ctx = getattr(request.state, 'auth_context', None)
        if auth_ctx:
            return auth_ctx
    
    raise HTTPException(status_code=401, detail="Invalid API key")

# Register proxy routes - routes already contain /v1 prefix, no need to add again
app.include_router(proxy_api.router, dependencies=[Depends(verify_user_auth)])

# Register gateway integration API (for third-party AI gateways like Higress, LiteLLM, Kong)
# See docs/THIRD_PARTY_GATEWAY_INTEGRATION.md for full documentation
app.include_router(gateway_integration_api.router, dependencies=[Depends(verify_user_auth)])

# Register direct model access API (uses its own authentication via model_api_key)
app.include_router(model_direct_access.router, prefix="/v1")

# Global exception handling
@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    logger.error(f"Proxy service exception: {exc}")
    return JSONResponse(
        status_code=500,
        content={"error": {"message": "Proxy service internal error", "type": "internal_error"}}
    )

if __name__ == "__main__":
    uvicorn.run(
        "proxy_service:app",
        host=settings.host,
        port=settings.proxy_port,
        reload=settings.debug,
        log_level=settings.log_level.lower(),
        workers=settings.proxy_uvicorn_workers if not settings.debug else 1
    )