from fastapi import HTTPException, Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
from database.connection import get_db_session
from services.rate_limiter import rate_limiter
from utils.logger import setup_logger

logger = setup_logger()

class RateLimitMiddleware(BaseHTTPMiddleware):
    """Rate limit middleware"""

    def __init__(self, app):
        super().__init__(app)
        self.protected_paths = ["/v1/guardrails"]  # Protected paths

    async def dispatch(self, request: Request, call_next):
        # Check if rate limiting is needed
        if not any(request.url.path.startswith(path) for path in self.protected_paths):
            return await call_next(request)

        # Get tenant ID
        auth_context = getattr(request.state, 'auth_context', None)
        if not auth_context:
            # No authentication information, skip rate limiting (let subsequent authentication middleware handle)
            return await call_next(request)

        tenant_id = auth_context['data'].get('tenant_id')  
        if not tenant_id:
            return await call_next(request)

        # Check rate limiting
        db = get_db_session()
        try:
            if not await rate_limiter.is_allowed(str(tenant_id), db):
                logger.warning(f"Rate limit exceeded for tenant {tenant_id} on {request.url.path}")
                return JSONResponse(
                    status_code=429,
                    content={
                        "error": {
                            "message": "Rate limit exceeded. Too many requests.",
                            "type": "rate_limit_exceeded", 
                            "code": 429
                        }
                    },
                    headers={"Retry-After": "1"}
                )
        except Exception as e:
            logger.error(f"Rate limit check failed: {e}")
            # When rate limiting check fails, allow requests through to avoid affecting service
        finally:
            db.close()
        
        return await call_next(request)