"""
Audit Log Router - Query and export operation audit logs.
Only accessible by Owner/Admin roles.
"""

import csv
import io
import uuid
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import and_

from database.connection import get_admin_db
from database.models import AuditLog, Tenant, TenantMember

router = APIRouter(tags=["AuditLog"])


def _get_authorized_tenant(request: Request, db: Session) -> Tenant:
    """Get current tenant and verify owner/admin role."""
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context or 'data' not in auth_context:
        raise HTTPException(status_code=401, detail="Not authenticated")

    data = auth_context['data']
    tenant_id = data.get('tenant_id')
    if not tenant_id:
        raise HTTPException(status_code=401, detail="Tenant ID not found")

    # Check role: only owner/admin can view audit logs
    member_role = data.get('member_role', '')
    is_super_admin = data.get('is_super_admin', False)

    if not is_super_admin and member_role not in ('owner', 'admin'):
        raise HTTPException(status_code=403, detail="Only owner or admin can access audit logs")

    try:
        tenant_uuid = uuid.UUID(str(tenant_id))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid tenant ID format")

    tenant = db.query(Tenant).filter(Tenant.id == tenant_uuid).first()
    if not tenant:
        raise HTTPException(status_code=404, detail="Tenant not found")

    return tenant


def _build_filters(
    tenant_id,
    user_id: Optional[str],
    action: Optional[str],
    resource_type: Optional[str],
    start_date: Optional[str],
    end_date: Optional[str],
    keyword: Optional[str],
    tz_offset: Optional[int] = None,
) -> list:
    """Build query filters for audit logs."""
    filters = [AuditLog.tenant_id == str(tenant_id)]

    if user_id:
        filters.append(AuditLog.user_id == user_id)
    if action:
        filters.append(AuditLog.action == action)
    if resource_type:
        filters.append(AuditLog.resource_type == resource_type)
    if start_date:
        try:
            start_dt = datetime.strptime(start_date, "%Y-%m-%d")
            if tz_offset is not None:
                start_dt = start_dt + timedelta(minutes=tz_offset)
            filters.append(AuditLog.created_at >= start_dt)
        except ValueError:
            pass
    if end_date:
        try:
            end_dt = datetime.strptime(end_date, "%Y-%m-%d")
            end_dt = end_dt.replace(hour=23, minute=59, second=59)
            if tz_offset is not None:
                end_dt = end_dt + timedelta(minutes=tz_offset)
            filters.append(AuditLog.created_at <= end_dt)
        except ValueError:
            pass
    if keyword:
        filters.append(AuditLog.resource_name.ilike(f"%{keyword}%"))

    return filters


def _build_user_cache(db: Session, tenant_id) -> dict:
    """Build a lookup cache for team member names."""
    members = db.query(TenantMember).filter(
        TenantMember.tenant_id == str(tenant_id)
    ).all()
    cache = {}
    for m in members:
        cache[str(m.user_id)] = {
            "email": m.email,
            "role": m.role,
        }
    return cache


@router.get("/audit-logs")
async def get_audit_logs(
    request: Request,
    db: Session = Depends(get_admin_db),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=100),
    user_id: Optional[str] = Query(None),
    action: Optional[str] = Query(None),
    resource_type: Optional[str] = Query(None),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    keyword: Optional[str] = Query(None),
    tz_offset: Optional[int] = Query(None, description="Client timezone offset in minutes"),
):
    """Get paginated audit logs with filters."""
    tenant = _get_authorized_tenant(request, db)

    filters = _build_filters(
        tenant.id, user_id, action, resource_type,
        start_date, end_date, keyword, tz_offset=tz_offset,
    )

    base_query = db.query(AuditLog).filter(and_(*filters))
    total = base_query.count()

    offset = (page - 1) * per_page
    logs = base_query.order_by(
        AuditLog.created_at.desc()
    ).offset(offset).limit(per_page).all()

    pages = (total + per_page - 1) // per_page if total > 0 else 0

    # Build user cache for display
    user_cache = _build_user_cache(db, tenant.id)

    items = []
    for log in logs:
        user_info = user_cache.get(str(log.user_id), {}) if log.user_id else {}
        items.append({
            "id": str(log.id),
            "user_id": str(log.user_id) if log.user_id else None,
            "user_email": log.user_email,
            "user_nickname": user_info.get("email"),
            "action": log.action,
            "resource_type": log.resource_type,
            "resource_id": log.resource_id,
            "resource_name": log.resource_name,
            "changes": log.changes,
            "ip_address": log.ip_address,
            "created_at": log.created_at.isoformat() if log.created_at else None,
        })

    # Get distinct values for filter dropdowns
    action_types = db.query(AuditLog.action).filter(
        AuditLog.tenant_id == str(tenant.id)
    ).distinct().all()
    resource_types = db.query(AuditLog.resource_type).filter(
        AuditLog.tenant_id == str(tenant.id)
    ).distinct().all()
    operator_list = db.query(AuditLog.user_id, AuditLog.user_email).filter(
        AuditLog.tenant_id == str(tenant.id)
    ).distinct().all()

    return {
        "items": items,
        "total": total,
        "page": page,
        "per_page": per_page,
        "pages": pages,
        "filter_options": {
            "actions": sorted([a[0] for a in action_types if a[0]]),
            "resource_types": sorted([r[0] for r in resource_types if r[0]]),
            "operators": [
                {"user_id": str(o[0]) if o[0] else None, "email": o[1]}
                for o in operator_list if o[1]
            ],
        },
    }


@router.get("/audit-logs/export")
async def export_audit_logs(
    request: Request,
    db: Session = Depends(get_admin_db),
    user_id: Optional[str] = Query(None),
    action: Optional[str] = Query(None),
    resource_type: Optional[str] = Query(None),
    start_date: Optional[str] = Query(None),
    end_date: Optional[str] = Query(None),
    keyword: Optional[str] = Query(None),
    tz_offset: Optional[int] = Query(None, description="Client timezone offset in minutes"),
):
    """Export audit logs as CSV."""
    tenant = _get_authorized_tenant(request, db)

    filters = _build_filters(
        tenant.id, user_id, action, resource_type,
        start_date, end_date, keyword, tz_offset=tz_offset,
    )

    logs = db.query(AuditLog).filter(
        and_(*filters)
    ).order_by(AuditLog.created_at.desc()).limit(10000).all()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Time", "Operator", "Action", "Resource Type",
        "Resource Name", "Resource ID", "Changes", "IP Address",
    ])

    for log in logs:
        import json
        changes_str = json.dumps(log.changes, ensure_ascii=False) if log.changes else ""
        writer.writerow([
            log.created_at.strftime("%Y-%m-%d %H:%M:%S") if log.created_at else "",
            log.user_email or "",
            log.action or "",
            log.resource_type or "",
            log.resource_name or "",
            log.resource_id or "",
            changes_str,
            log.ip_address or "",
        ])

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={
            "Content-Disposition": f"attachment; filename=audit_logs_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
        },
    )
