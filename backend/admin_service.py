#!/usr/bin/env python3
"""
Management service - low concurrency management platform API
Specially handles /api/v1/* management interface requests, optimizing resource usage
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
from database.connection import init_db, create_admin_engine
from routers import dashboard, config_api, results, auth, user, sync, admin, online_test, test_models, risk_config_api, proxy_management, concurrent_stats, media, data_security, billing
from utils.logger import setup_logger
from services.admin_service import admin_service

# Set security verification
security = HTTPBearer()

# Import concurrent control middleware
from middleware.concurrent_limit_middleware import ConcurrentLimitMiddleware

class AuthContextMiddleware(BaseHTTPMiddleware):
    """Authentication context middleware - management service version (full version)"""
    
    async def dispatch(self, request: Request, call_next):
        # Handle management API routes
        if request.url.path.startswith('/api/v1/'):
            auth_header = request.headers.get('authorization')
            switch_session = request.headers.get('x-switch-session')

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
                        auth_context = await self._get_auth_context(token, switch_session)
                        request.state.auth_context = auth_context
                    except:
                        request.state.auth_context = None
                else:
                    request.state.auth_context = None
            else:
                request.state.auth_context = None

        response = await call_next(request)
        return response
    
    async def _get_auth_context(self, token: str, switch_session: str = None):
        """Get authentication context (full version, supports user switch)"""
        from utils.auth_cache import auth_cache
        
        # Generate cache key
        cache_key = f"{token}:{switch_session or ''}"
        
        # Check cache
        cached_auth = auth_cache.get(cache_key)
        if cached_auth:
            return cached_auth
        
        from database.connection import get_admin_db_session
        from database.models import Tenant
        from utils.user import get_user_by_api_key
        from utils.auth import verify_token
        
        db = get_admin_db_session()
        try:
            auth_context = None
            
            # JWT verification
            try:
                user_data = verify_token(token)
                role = user_data.get('role')
                
                if role == 'admin':
                    subject_email = user_data.get('username') or user_data.get('sub')
                    admin_user = db.query(Tenant).filter(Tenant.email == subject_email).first()
                    if admin_user:
                        auth_context = {
                            "type": "jwt_admin",
                            "data": {
                                "tenant_id": str(admin_user.id),
                                "email": admin_user.email,
                                "is_super_admin": admin_service.is_super_admin(admin_user)
                            }
                        }
                else:
                    raw_tenant_id = user_data.get('tenant_id') or user_data.get('sub')
                    tenant_uuid = None
                    if isinstance(raw_tenant_id, str):
                        try:
                            tenant_uuid = uuid.UUID(raw_tenant_id)
                        except ValueError:
                            pass
                    
                    user = db.query(Tenant).filter(Tenant.id == tenant_uuid).first() if tenant_uuid else None
                    if user:
                        # Check user switch
                        if switch_session and admin_service.is_super_admin(user):
                            switched_user = admin_service.get_switched_user(db, switch_session)
                            if switched_user:
                                auth_context = {
                                    "type": "jwt_switched",
                                    "data": {
                                        "tenant_id": str(switched_user.id),
                                        "email": switched_user.email,
                                        "original_admin_id": str(user.id),
                                        "original_admin_email": user.email,
                                        "switch_session": switch_session
                                    }
                                }
                        
                        if not auth_context:
                            auth_context = {
                                "type": "jwt", 
                                "data": {
                                    "tenant_id": str(user.id),
                                    "email": user.email,
                                    "is_super_admin": admin_service.is_super_admin(user)
                                }
                            }
            except:
                # API key verification
                user = get_user_by_api_key(db, token)
                if user:
                    # Check user switch
                    if switch_session and admin_service.is_super_admin(user):
                        switched_user = admin_service.get_switched_user(db, switch_session)
                        if switched_user:
                            auth_context = {
                                "type": "api_key_switched",
                                "data": {
                                    "tenant_id": str(switched_user.id),
                                    "email": switched_user.email,
                                    "api_key": switched_user.api_key,
                                    "original_admin_id": str(user.id),
                                    "original_admin_email": user.email,
                                    "switch_session": switch_session
                                }
                            }
                    
                    if not auth_context:
                        auth_context = {
                            "type": "api_key", 
                            "data": {
                                "tenant_id": str(user.id),
                                "email": user.email,
                                "api_key": user.api_key,
                                "is_super_admin": admin_service.is_super_admin(user)
                            }
                        }
            
            # Cache authentication result
            if auth_context:
                auth_cache.set(cache_key, auth_context)
            
            return auth_context
            
        finally:
            db.close()

# Create FastAPI application
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup phase
    os.makedirs(settings.data_dir, exist_ok=True)
    os.makedirs(settings.log_dir, exist_ok=True)

    # Initialize database (management service needs full initialization)
    await init_db(minimal=False)

    # Start cache cleaner
    from services.cache_cleaner import cache_cleaner
    await cache_cleaner.start()

    # Start log to database service (replaces old data_sync_service)
    # This service provides better incremental processing and state persistence
    if settings.store_detection_results:
        from services.log_to_db_service import log_to_db_service
        await log_to_db_service.start()
        logger.info("Log to DB service started (STORE_DETECTION_RESULTS=true)")
    else:
        logger.info("Log to DB service disabled (STORE_DETECTION_RESULTS=false)")

    logger.info(f"{settings.app_name} Admin Service started")
    logger.info(f"Data directory: {settings.data_dir}")
    logger.info("Admin service optimized for management operations")
    
    try:
        yield
    finally:
        # Shutdown phase
        from services.cache_cleaner import cache_cleaner
        await cache_cleaner.stop()
        if settings.store_detection_results:
            from services.log_to_db_service import log_to_db_service
            await log_to_db_service.stop()
        logger.info("Admin service shutdown completed")

app = FastAPI(
    title=f"{settings.app_name} - Admin Service",
    version=settings.app_version,
    description="OpenGuardrails management service - management platform API",
    docs_url="/docs" if settings.debug else None,
    redoc_url="/redoc" if settings.debug else None,
    lifespan=lifespan,
)

# Add concurrent control middleware (highest priority, added last)
app.add_middleware(ConcurrentLimitMiddleware, service_type="admin", max_concurrent=settings.admin_max_concurrent_requests)

# Add authentication context middleware
app.add_middleware(AuthContextMiddleware)

# Configure CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# Set log
logger = setup_logger()

@app.get("/")
async def root():
    """Root path"""
    return {
        "name": f"{settings.app_name} - Admin Service",
        "version": settings.app_version,
        "status": "running",
        "service_type": "admin",
        "support_email": settings.support_email,
        "workers": settings.admin_uvicorn_workers
    }

@app.get("/health")
async def health_check():
    """Health check"""
    return {
        "status": "healthy", 
        "version": settings.app_version,
        "service": "admin"
    }

# User authentication function (full version)
async def verify_user_auth(
    credentials: HTTPAuthorizationCredentials = Security(security),
    request: Request = None,
):
    """Verify user authentication (management service only)"""
    # Use middleware to parse authentication context
    if request is not None:
        auth_ctx = getattr(request.state, 'auth_context', None)
        if auth_ctx:
            return auth_ctx
    
    # If the middleware is not parsed, perform complete verification
    token = credentials.credentials
    from database.connection import get_admin_db_session
    from database.models import Tenant
    from utils.user import get_user_by_api_key
    from utils.auth import verify_token
    
    db = get_admin_db_session()
    try:
        # JWT verification
        try:
            user_data = verify_token(token)
            raw_tenant_id = user_data.get('tenant_id') or user_data.get('sub')
            if isinstance(raw_tenant_id, str):
                try:
                    tenant_uuid = uuid.UUID(raw_tenant_id)
                    user = db.query(Tenant).filter(Tenant.id == tenant_uuid).first()
                    if user and user.is_active:
                        return {
                            "type": "jwt", 
                            "data": {
                                "tenant_id": str(user.id),
                                "email": user.email,
                                "is_super_admin": admin_service.is_super_admin(user)
                            }
                        }
                except ValueError:
                    pass
        except:
            pass
        
        # API key verification
        user = get_user_by_api_key(db, token)
        if user:
            return {
                "type": "api_key", 
                "data": {
                    "tenant_id": str(user.id),
                    "email": user.email,
                    "api_key": user.api_key,
                    "is_super_admin": admin_service.is_super_admin(user)
                }
            }
        
        raise HTTPException(status_code=401, detail="Invalid credentials")
        
    finally:
        db.close()

# Register management routes
app.include_router(auth.router, prefix="/api/v1/auth")
app.include_router(user.router, prefix="/api/v1/users")
app.include_router(dashboard.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(config_api.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(results.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(sync.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(admin.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(online_test.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(test_models.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(risk_config_api.router, dependencies=[Depends(verify_user_auth)])
app.include_router(proxy_management.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(concurrent_stats.router, dependencies=[Depends(verify_user_auth)])
app.include_router(data_security.router, dependencies=[Depends(verify_user_auth)])
app.include_router(billing.router, dependencies=[Depends(verify_user_auth)])  # Billing APIs

# Import and register ban policy routes
from routers import ban_policy_api
app.include_router(ban_policy_api.router, dependencies=[Depends(verify_user_auth)])
# Media router: image upload/delete needs authentication, but image access does not need authentication
# First register image access routes that do not need authentication
from fastapi import APIRouter
from fastapi.responses import FileResponse
from pathlib import Path

public_media_router = APIRouter(tags=["Media"])

@public_media_router.get("/media/image/{tenant_id}/{filename}")
async def get_image_public(tenant_id: str, filename: str):
    """Get image file (public access, no authentication)"""
    try:
        file_path = Path(settings.media_dir) / tenant_id / filename
        if not str(file_path).startswith(str(Path(settings.media_dir))):
            raise HTTPException(status_code=403, detail="No access to this file")
        if not file_path.exists() or not file_path.is_file():
            raise HTTPException(status_code=404, detail="File not found")
        return FileResponse(path=str(file_path), media_type="image/jpeg", filename=filename)
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Get image error: {e}")
        raise HTTPException(status_code=500, detail=f"Get image failed: {str(e)}")

app.include_router(public_media_router, prefix="/api/v1")
app.include_router(media.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])

# Global exception handling
@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    logger.error(f"Admin service exception: {exc}")
    return JSONResponse(
        status_code=500,
        content={"detail": "Admin service internal error"}
    )

if __name__ == "__main__":
    uvicorn.run(
        "admin_service:app",
        host=settings.host,
        port=settings.admin_port,
        reload=settings.debug,
        log_level=settings.log_level.lower(),
        workers=settings.admin_uvicorn_workers if not settings.debug else 1
    )