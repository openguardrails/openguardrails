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
from routers import proxy_api
from services.async_logger import async_detection_logger
from utils.logger import setup_logger

# Set security verification
security = HTTPBearer()

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
        """Get authentication context (proxy service专用 - support API key verification)"""
        from utils.auth_cache import auth_cache
        from utils.auth import verify_token
        
        # Check cache
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
                    auth_context = {
                        "type": "jwt", 
                        "data": {
                            "tenant_id": raw_tenant_id,
                            "email": user_data.get('email', 'unknown')
                        }
                    }
                except ValueError:
                    pass
        except:
            # JWT verification failed, try API key verification
            try:
                from database.connection import get_admin_db_session
                from utils.user import get_user_by_api_key
                
                db = get_admin_db_session()
                try:
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
                finally:
                    db.close()
            except Exception as e:
                logger.error(f"API key verification failed: {e}")
        
        # If all verification fails, do not create anonymous user context
        # This will trigger a 401 error, which is expected behavior for the API
        
        # Cache authentication result
        if auth_context:
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
            "GET /v1/models"
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