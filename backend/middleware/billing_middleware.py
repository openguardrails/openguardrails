"""
Billing Middleware - Check monthly quota limits before processing requests
Only active in SaaS mode; disabled in enterprise mode.
"""

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
from database.connection import get_db_session
from services.billing_service import billing_service
from utils.logger import setup_logger
from config import settings

logger = setup_logger()


class BillingMiddleware(BaseHTTPMiddleware):
    """Middleware to check monthly quota limits (SaaS mode only)"""

    def __init__(self, app):
        super().__init__(app)
        # Paths that require billing checks
        self.protected_paths = [
            "/v1/guardrails",  # Detection API
            "/v1/chat/completions"  # Proxy API
        ]

    async def dispatch(self, request: Request, call_next):
        # Skip billing checks in enterprise mode
        if settings.is_enterprise_mode:
            return await call_next(request)

        # Check if this path requires billing check
        if not any(request.url.path.startswith(path) for path in self.protected_paths):
            return await call_next(request)

        # Get tenant ID from authentication context
        auth_context = getattr(request.state, 'auth_context', None)
        if not auth_context:
            # No authentication, skip billing check (authentication middleware will handle)
            return await call_next(request)

        tenant_id = auth_context['data'].get('tenant_id')
        if not tenant_id:
            return await call_next(request)

        # Check and increment usage
        db = get_db_session()
        try:
            is_allowed, error_message = billing_service.check_and_increment_usage(
                str(tenant_id), db
            )

            if not is_allowed:
                logger.warning(
                    f"Billing quota exceeded for tenant {tenant_id} on {request.url.path}"
                )
                return JSONResponse(
                    status_code=429,
                    content={
                        "error": {
                            "message": error_message or "Monthly quota exceeded. Please upgrade your plan or wait for quota reset.",
                            "type": "quota_exceeded",
                            "code": 429
                        }
                    },
                    headers={
                        "Retry-After": "86400"  # Suggest retry after 1 day
                    }
                )

        except Exception as e:
            logger.error(f"Billing check failed for tenant {tenant_id}: {e}")
            # On error, allow request through to avoid service disruption
        finally:
            db.close()

        # Quota check passed, proceed with request
        return await call_next(request)
