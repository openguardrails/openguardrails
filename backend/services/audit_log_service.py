"""
Audit Log Service - Records all admin operations for audit trail.

Usage in routers:
    from services.audit_log_service import log_operation, compute_changes

    # Simple action (no changes tracking)
    await log_operation(db, request, "create", "application", resource_id=str(app.id), resource_name=app.name)

    # With change tracking
    old_data = {"keywords": old_keywords}
    new_data = {"keywords": new_keywords}
    changes = compute_changes(old_data, new_data)
    await log_operation(db, request, "update", "blacklist", resource_id=str(bl.id), changes=changes)
"""

import logging
from typing import Optional
from sqlalchemy.orm import Session
from fastapi import Request
from database.models import AuditLog

logger = logging.getLogger(__name__)

# Fields that should never have their values logged
SENSITIVE_FIELDS = {
    "password", "password_hash", "api_key", "secret", "token",
    "jwt", "credential", "private_key", "model_api_key",
    "invitation_token", "new_password", "old_password",
}


def _extract_client_info(request: Optional[Request]) -> tuple:
    """Extract IP address and user agent from request."""
    if not request:
        return None, None

    # Support X-Forwarded-For for reverse proxy
    ip_address = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    if not ip_address:
        ip_address = request.headers.get("x-real-ip", "")
    if not ip_address and request.client:
        ip_address = request.client.host

    user_agent = request.headers.get("user-agent", "")
    return ip_address, user_agent


def _extract_auth_info(request: Optional[Request]) -> tuple:
    """Extract tenant_id, user_id, email from request auth context."""
    if not request:
        return None, None, None

    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context:
        return None, None, None

    data = auth_context.get('data', {})
    tenant_id = str(data.get('original_admin_id') or data.get('tenant_id') or '')
    user_id = str(data.get('user_id') or data.get('tenant_id') or '')
    email = data.get('email', '')

    return tenant_id or None, user_id or None, email or None


def compute_changes(
    old_data: dict,
    new_data: dict,
    sensitive_fields: set = None,
) -> Optional[dict]:
    """
    Compare two dicts and return the differences.
    Sensitive fields are masked with "***".
    Returns None if no changes detected.
    """
    if sensitive_fields is None:
        sensitive_fields = SENSITIVE_FIELDS

    changes = {}
    all_keys = set(old_data.keys()) | set(new_data.keys())

    for key in all_keys:
        old_val = old_data.get(key)
        new_val = new_data.get(key)

        if old_val != new_val:
            if key.lower() in sensitive_fields or any(s in key.lower() for s in sensitive_fields):
                changes[key] = {"old": "***", "new": "***"}
            else:
                changes[key] = {"old": old_val, "new": new_val}

    return changes if changes else None


async def log_operation(
    db: Session,
    request: Optional[Request],
    action: str,
    resource_type: str,
    resource_id: str = None,
    resource_name: str = None,
    changes: dict = None,
    tenant_id: str = None,
    user_id: str = None,
    user_email: str = None,
):
    """
    Record an admin operation to the audit log.

    Args:
        db: Database session
        request: FastAPI request (for auth context and client info)
        action: Operation type - create/update/delete/login/logout/export/import
        resource_type: Resource being operated on - application/workspace/blacklist/...
        resource_id: ID of the resource
        resource_name: Human-readable name of the resource
        changes: Dict of changes {"field": {"old": x, "new": y}}
        tenant_id: Override tenant_id (if not from request)
        user_id: Override user_id (if not from request)
        user_email: Override user_email (if not from request)
    """
    try:
        # Extract info from request if not explicitly provided
        req_tenant_id, req_user_id, req_email = _extract_auth_info(request)
        ip_address, user_agent = _extract_client_info(request)

        audit_log = AuditLog(
            tenant_id=tenant_id or req_tenant_id,
            user_id=user_id or req_user_id,
            user_email=user_email or req_email,
            action=action,
            resource_type=resource_type,
            resource_id=str(resource_id) if resource_id else None,
            resource_name=resource_name,
            changes=changes,
            ip_address=ip_address,
            user_agent=user_agent,
        )
        db.add(audit_log)
        db.commit()
    except Exception as e:
        logger.error(f"Failed to write audit log: {e}")
        try:
            db.rollback()
        except Exception:
            pass
