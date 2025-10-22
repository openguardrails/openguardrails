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
from database.connection import init_db
from routers import guardrails, dashboard, config_api, results, auth, user, sync, admin, online_test, test_models, media, data_security, risk_config_api, proxy_management, dify_moderation
from services.async_logger import async_detection_logger
from services.data_sync_service import data_sync_service
from utils.logger import setup_logger
from services.admin_service import admin_service

# Set security verification
security = HTTPBearer()

class AuthContextMiddleware(BaseHTTPMiddleware):
    """Authentication context middleware"""
    
    async def dispatch(self, request: Request, call_next):
        # Add user context to routes that need authentication
        if request.url.path.startswith('/v1/guardrails') or request.url.path.startswith('/v1/dify') or request.url.path.startswith('/api/v1/'):
            auth_header = request.headers.get('authorization')
            switch_session = request.headers.get('x-switch-session')  # User switch session

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
        """Get authentication context (with cache optimization)"""
        from utils.auth_cache import auth_cache
        
        # Generate cache key (contains switch_session information)
        cache_key = f"{token}:{switch_session or ''}"
        
        # Try to get from cache
        cached_auth = auth_cache.get(cache_key)
        if cached_auth:
            return cached_auth
        
        # Cache miss, execute original logic
        from database.connection import get_db_session
        from database.models import Tenant
        from utils.user import get_user_by_api_key
        from utils.auth import verify_token
        
        
        db = get_db_session()
        try:
            auth_context = None
            
            # First try JWT verification
            try:
                user_data = verify_token(token)
                role = user_data.get('role')
                # Admin token: find admin user by email
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
                        # Still mark as admin context but no user_id (can be verified later)
                        auth_context = {
                            "type": "jwt_admin",
                            "data": {
                                "tenant_id": None,
                                "email": subject_email,
                                "is_super_admin": True
                            }
                        }
                else:
                    # Normal user: parse tenant_id from token
                    raw_tenant_id = user_data.get('tenant_id') or user_data.get('sub')
                    tenant_uuid = None
                    if isinstance(raw_tenant_id, uuid.UUID):
                        tenant_uuid = raw_tenant_id
                    elif isinstance(raw_tenant_id, str):
                        try:
                            tenant_uuid = uuid.UUID(raw_tenant_id)
                        except ValueError:
                            tenant_uuid = None
                    user = db.query(Tenant).filter(Tenant.id == tenant_uuid).first() if tenant_uuid else None
                    if user:
                        # Check if there is a user switch session
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
                                    # Only judge super admin based on .env
                                    "is_super_admin": admin_service.is_super_admin(user)
                                }
                            }
                    else:
                        # When the user is not found in the database, fallback to the context based on token declaration
                        auth_context = {
                            "type": "jwt",
                            "data": {
                                "tenant_id": str(raw_tenant_id) if raw_tenant_id else None,
                                "email": user_data.get('email'),
                                "is_super_admin": bool(user_data.get('is_super_admin', False))
                            }
                        }
            except:
                # JWT verification failed, try API key verification
                user = get_user_by_api_key(db, token)
                if user:
                    # Check if there is a user switch session
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
                                # Only judge super admin based on .env
                                "is_super_admin": admin_service.is_super_admin(user)
                            }
                        }
            
            # If authentication is successful, cache the result
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
    os.makedirs(settings.detection_log_dir, exist_ok=True)

    # Initialize database
    await init_db()

    # Start asynchronous logging service and background tasks
    await async_detection_logger.start()
    await data_sync_service.start()
    from services.cache_cleaner import cache_cleaner
    await cache_cleaner.start()

    logger.info(f"{settings.app_name} {settings.app_version} started")
    logger.info(f"Data directory: {settings.data_dir}")
    logger.info(f"Model API URL: {settings.guardrails_model_api_url}")
    logger.info("Async logging, data sync and cache cleaner services started")
    try:
        yield
    finally:
        # Shutdown phase
        await async_detection_logger.stop()
        await data_sync_service.stop()
        from services.cache_cleaner import cache_cleaner
        await cache_cleaner.stop()
        from services.model_service import model_service
        await model_service.close()
        logger.info("Application shutdown completed")


app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="OpenGuardrails platform - provides comprehensive security protection for LLM applications",
    docs_url="/docs" if settings.debug else None,
    redoc_url="/redoc" if settings.debug else None,
    lifespan=lifespan,
)

# Add rate limit middleware - must be added first (will be executed later)
from middleware.rate_limit_middleware import RateLimitMiddleware
app.add_middleware(RateLimitMiddleware)

# Add authentication context middleware - added later (will be executed first)
app.add_middleware(AuthContextMiddleware)

# Configure CORS - supports SSH port mapping
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all domains
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# Set log
logger = setup_logger()

# Lifecycle is managed through lifespan

@app.get("/")
async def root():
    """Root path"""
    return {
        "name": settings.app_name,
        "version": settings.app_version,
        "status": "running",
        "model_api_url": settings.guardrails_model_api_url,
        "support_email": settings.support_email,
        "huggingface_model": settings.huggingface_model
    }

@app.get("/health")
async def health_check():
    """Health check"""
    return {"status": "healthy", "version": settings.app_version}

# Register routes
# Authentication and user routes do not need API key verification
app.include_router(auth.router, prefix="/api/v1/auth")
app.include_router(user.router, prefix="/api/v1/users")

# Other routes need JWT authentication or API key verification
from routers.auth import get_current_admin

async def verify_user_auth(
    credentials: HTTPAuthorizationCredentials = Security(security),
    request: Request = None,
):
    """Verify user authentication (JWT token or API key)"""
    from database.connection import get_db_session
    from database.models import Tenant
    from utils.user import get_user_by_api_key
    from utils.auth import verify_token
    
    # If the authentication context is parsed out by the middleware, trust it directly (to avoid 401 caused by repeated parsing differences)
    if request is not None:
        auth_ctx = getattr(request.state, 'auth_context', None)
        if auth_ctx:
            return auth_ctx

    token = credentials.credentials
    db = get_db_session()
    
    try:
        try:
            user_data = verify_token(token)
            role = user_data.get('role')
            if role == 'admin':
                subject_email = user_data.get('username') or user_data.get('sub')
                admin_user = db.query(Tenant).filter(Tenant.email == subject_email).first()
                if admin_user and admin_user.is_active:
                    ctx = {
                        "type": "jwt_admin",
                        "data": {
                            "tenant_id": str(admin_user.id),
                            "email": admin_user.email,
                            "is_super_admin": admin_service.is_super_admin(admin_user)
                        }
                    }
                    if request is not None:
                        try:
                            request.state.auth_context = ctx
                        except Exception:
                            pass
                    return ctx
            else:
                # Compatible with old token: prioritize tenant_id, fallback to sub
                raw_tenant_id = user_data.get('tenant_id') or user_data.get('sub')
                tenant_uuid = None
                if isinstance(raw_tenant_id, uuid.UUID):
                    tenant_uuid = raw_tenant_id
                elif isinstance(raw_tenant_id, str):
                    try:
                        tenant_uuid = uuid.UUID(raw_tenant_id)
                    except ValueError:
                        tenant_uuid = None

                user = db.query(Tenant).filter(Tenant.id == tenant_uuid).first() if tenant_uuid else None
                if user and user.is_active:
                    ctx = {
                        "type": "jwt", 
                        "data": {
                            "tenant_id": str(user.id),
                            "email": user.email,
                            # Only judge super admin based on .env
                            "is_super_admin": admin_service.is_super_admin(user)
                        }
                    }
                    if request is not None:
                        try:
                            request.state.auth_context = ctx
                        except Exception:
                            pass
                    return ctx
                else:
                    # Fallback: accept token declaration (even if the DB cannot be queried), avoid false 401
                    ctx = {
                        "type": "jwt",
                        "data": {
                            "tenant_id": str(raw_tenant_id) if raw_tenant_id else None,
                            "email": user_data.get('email'),
                            "is_super_admin": bool(user_data.get('is_super_admin', False))
                        }
                    }
                    if request is not None:
                        try:
                            request.state.auth_context = ctx
                        except Exception:
                            pass
                    return ctx
        except:
            pass
        
        # JWT verification failed, try API key verification
        user = get_user_by_api_key(db, token)
        # 允许使用有效的 API Key 直接访问（不强制邮箱激活）
        if user:
            ctx = {
                "type": "api_key", 
                "data": {
                    "tenant_id": str(user.id),
                    "email": user.email,
                    "api_key": user.api_key,
                    # Only judge super admin based on .env
                    "is_super_admin": admin_service.is_super_admin(user)
                }
            }
            if request is not None:
                try:
                    request.state.auth_context = ctx
                except Exception:
                    pass
            return ctx
        
        raise HTTPException(status_code=401, detail="Invalid credentials")
        
    finally:
        db.close()

app.include_router(guardrails.router, prefix="/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(dify_moderation.router, prefix="/v1", dependencies=[Depends(verify_user_auth)])  # Dify API-based Extension
app.include_router(dashboard.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(config_api.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(risk_config_api.router, dependencies=[Depends(verify_user_auth)])  # risk_config_api已在路由内定义prefix
app.include_router(proxy_management.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(results.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(sync.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(admin.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(online_test.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(test_models.router, prefix="/api/v1", dependencies=[Depends(verify_user_auth)])
app.include_router(data_security.router, dependencies=[Depends(verify_user_auth)])  # data_security已在路由内定义prefix
app.include_router(media.router, prefix="/api/v1")  # media路由的认证在各个接口中单独控制

# Global exception handling
@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    logger.error(f"Global exception: {exc}")
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"}
    )

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.admin_port,
        reload=settings.debug,
        log_level=settings.log_level.lower(),
        workers=settings.admin_uvicorn_workers if not settings.debug else 1
    )
