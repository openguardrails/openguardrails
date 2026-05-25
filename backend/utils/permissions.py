"""Role-based permission utilities for team member access control."""
from fastapi import HTTPException, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse


def require_role(*allowed_roles):
    """
    FastAPI dependency that checks member_role from auth_context.
    Super admins always pass.

    Usage: Depends(require_role('owner', 'admin'))
    """
    def check(request: Request):
        auth_context = getattr(request.state, 'auth_context', None)
        if not auth_context or 'data' not in auth_context:
            raise HTTPException(status_code=401, detail="Not authenticated")

        data = auth_context['data']

        # Super admins bypass role checks
        if data.get('is_super_admin'):
            return data

        member_role = data.get('member_role', 'owner')
        if member_role not in allowed_roles:
            raise HTTPException(
                status_code=403,
                detail="Insufficient permissions. This action requires admin or owner role."
            )
        return data
    return check


# Convenience shortcuts
require_admin = require_role('owner', 'admin')
require_owner = require_role('owner')


class RoleCheckMiddleware(BaseHTTPMiddleware):
    """Middleware that blocks write operations for member-role users on protected paths."""

    WRITE_METHODS = {'POST', 'PUT', 'PATCH', 'DELETE'}

    PROTECTED_PREFIXES = [
        '/api/v1/config/',
        '/api/v1/applications/',
        '/api/v1/proxy/',
        '/api/v1/risk-config',
        '/api/v1/data-security/',
        '/api/v1/data-leakage-policy/',
        '/api/v1/gateway-policy/',
        '/api/v1/workspaces/',
        '/api/v1/gateway-connections/',
        '/api/v1/scanner-packages/',
        '/api/v1/scanner-configs/',
        '/api/v1/custom-scanners/',
        '/api/v1/ban-policy/',
        '/api/v1/appeal/',
        '/api/v1/model-routes/',
    ]

    # Endpoints that members CAN use even with write methods
    MEMBER_ALLOWED = [
        '/api/v1/users/language',
        '/api/v1/users/change-password',
        '/api/v1/users/logout',
        '/api/v1/online-test/',
        '/api/v1/team/invitations/accept',
    ]

    async def dispatch(self, request, call_next):
        if request.method in self.WRITE_METHODS:
            path = request.url.path
            is_protected = any(path.startswith(p) for p in self.PROTECTED_PREFIXES)
            is_allowed = any(path.startswith(p) for p in self.MEMBER_ALLOWED)

            if is_protected and not is_allowed:
                auth_context = getattr(request.state, 'auth_context', None)
                if auth_context and 'data' in auth_context:
                    data = auth_context['data']
                    if not data.get('is_super_admin'):
                        member_role = data.get('member_role', 'owner')
                        if member_role == 'member':
                            return JSONResponse(
                                status_code=403,
                                content={"detail": "Read-only access. Contact your admin to make changes."}
                            )

        return await call_next(request)
