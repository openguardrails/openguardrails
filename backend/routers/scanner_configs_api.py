"""
Scanner Configuration API Router
Handles per-application scanner configuration management
"""

from typing import List, Optional
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, status, Header, Request
from sqlalchemy.orm import Session

from database.connection import get_admin_db
from services.scanner_config_service import ScannerConfigService
from models.requests import (
    ScannerConfigUpdateRequest,
    ScannerConfigBulkUpdateRequest
)
from models.responses import ScannerConfigResponse, ApiResponse
from utils.logger import setup_logger
from services.audit_log_service import log_operation, compute_changes

logger = setup_logger()

router = APIRouter(prefix="/api/v1/scanner-configs", tags=["Scanner Configs"])


def get_current_user(request: Request) -> dict:
    """Get current user from request context"""
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # Handle both auth_context formats: direct dict and {data: dict}
    if isinstance(auth_context, dict) and 'data' in auth_context:
        return auth_context['data']
    elif isinstance(auth_context, dict):
        return auth_context
    else:
        raise HTTPException(status_code=401, detail="Invalid auth context")


def require_super_admin(request: Request) -> dict:
    """Require super admin access"""
    user = get_current_user(request)
    if not user.get('is_super_admin'):
        raise HTTPException(status_code=403, detail="Super admin access required")
    return user



def get_application_id(
    request: Request,
    x_application_id: Optional[str] = Header(None)
) -> UUID:
    """
    Extract application ID from header or use default.
    """
    if x_application_id:
        try:
            return UUID(x_application_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid X-Application-ID format"
            )

    # Use default application ID from user context
    current_user = get_current_user(request)
    if current_user and 'application_id' in current_user and current_user['application_id']:
        return UUID(current_user['application_id'])

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="No application context. Please provide X-Application-ID header."
    )


# =====================================================
# Scanner Configuration Endpoints
# =====================================================

@router.get("", response_model=List[ScannerConfigResponse])
async def get_application_scanners(
    request: Request,
    include_disabled: bool = True,
    application_id: UUID = Depends(get_application_id),
    db: Session = Depends(get_admin_db)
):
    """
    Get all scanner configurations for application.

    Returns scanners from:
    1. Built-in packages (always available)
    2. Purchased packages (if tenant purchased)
    3. Custom scanners (if created by this application)

    Query params:
    - include_disabled: Whether to include disabled scanners (default: true)
    """
    current_user = get_current_user(request)
    service = ScannerConfigService(db)
    tenant_id = UUID(current_user['tenant_id'])

    scanners = service.get_application_scanners(
        application_id=application_id,
        tenant_id=tenant_id,
        include_disabled=include_disabled
    )

    result = [ScannerConfigResponse(**scanner) for scanner in scanners]

    logger.info(
        f"User {current_user['email']} retrieved {len(result)} scanner configs "
        f"for app={application_id}"
    )

    return result


@router.get("/enabled", response_model=List[ScannerConfigResponse])
async def get_enabled_scanners(
    request: Request,
    scan_type: Optional[str] = None,
    application_id: UUID = Depends(get_application_id),
    db: Session = Depends(get_admin_db)
):
    """
    Get only enabled scanner configurations for detection.

    Query params:
    - scan_type: Filter by 'prompt' or 'response' (optional)
    """
    current_user = get_current_user(request)
    if scan_type and scan_type not in ['prompt', 'response']:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="scan_type must be 'prompt' or 'response'"
        )

    service = ScannerConfigService(db)
    tenant_id = UUID(current_user['tenant_id'])

    scanners = service.get_enabled_scanners(
        application_id=application_id,
        tenant_id=tenant_id,
        scan_type=scan_type
    )

    result = [ScannerConfigResponse(**scanner) for scanner in scanners]

    logger.info(
        f"User {current_user['email']} retrieved {len(result)} enabled scanners "
        f"(type={scan_type}) for app={application_id}"
    )

    return result


@router.put("/{scanner_id}", response_model=ApiResponse)
async def update_scanner_config(
    request: Request,
    scanner_id: str,
    updates: ScannerConfigUpdateRequest,
    application_id: UUID = Depends(get_application_id),
    db: Session = Depends(get_admin_db)
):
    """
    Update scanner configuration for application.

    Can update:
    - is_enabled: Enable/disable scanner
    - risk_level: Override default risk level
    - scan_prompt: Override prompt scanning setting
    - scan_response: Override response scanning setting
    """
    current_user = get_current_user(request)
    service = ScannerConfigService(db)

    try:
        scanner_uuid = UUID(scanner_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid scanner ID format"
        )

    update_dict = updates.model_dump(exclude_unset=True)

    # Capture old values before update for audit log
    field_map = {"is_enabled": "is_enabled", "risk_level": "risk_level_override", "scan_prompt": "scan_prompt_override", "scan_response": "scan_response_override"}
    from database.models import ApplicationScannerConfig
    from services.workspace_resolver import get_workspace_id_for_app
    ws_id = get_workspace_id_for_app(db, str(application_id))
    old_config = db.query(ApplicationScannerConfig).filter(
        ApplicationScannerConfig.workspace_id == ws_id,
        ApplicationScannerConfig.application_id.is_(None),
        ApplicationScannerConfig.scanner_id == scanner_uuid
    ).first() if ws_id else None
    old_data = {k: getattr(old_config, field_map.get(k, k), None) for k in update_dict} if old_config else {k: None for k in update_dict}

    try:
        config = service.update_scanner_config(
            application_id=application_id,
            scanner_id=scanner_uuid,
            updates=update_dict
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )

    logger.info(
        f"User {current_user['email']} updated scanner config: "
        f"app={application_id}, scanner={scanner_id}, "
        f"updates={list(update_dict.keys())}"
    )

    new_data = {k: getattr(config, field_map.get(k, k), None) for k in update_dict}
    changes = compute_changes(old_data, new_data)

    await log_operation(
        db=db, request=request, action="update",
        resource_type="scanner_config",
        resource_id=scanner_id,
        resource_name=f"scanner_{scanner_id}",
        changes=changes,
    )

    return ApiResponse(
        success=True,
        message="Scanner configuration updated successfully",
        data={"config_id": str(config.id)}
    )


@router.post("/bulk-update", response_model=ApiResponse)
async def bulk_update_scanner_configs(
    request: Request,
    bulk_updates: ScannerConfigBulkUpdateRequest,
    application_id: UUID = Depends(get_application_id),
    db: Session = Depends(get_admin_db)
):
    """
    Bulk update multiple scanner configurations.

    Request body:
    {
      "updates": [
        {
          "scanner_id": "uuid",
          "is_enabled": true,
          "risk_level": "high_risk",
          ...
        },
        ...
      ]
    }
    """
    current_user = get_current_user(request)
    service = ScannerConfigService(db)

    # Convert to dict format expected by service
    updates_list = [item.model_dump(exclude_unset=True) for item in bulk_updates.updates]

    try:
        configs = service.bulk_update_scanner_configs(
            application_id=application_id,
            updates=updates_list
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )

    logger.info(
        f"User {current_user['email']} bulk updated {len(configs)} scanner configs "
        f"for app={application_id}"
    )

    await log_operation(
        db=db, request=request, action="update",
        resource_type="scanner_config",
        resource_id=str(application_id),
        resource_name=f"bulk_update_{len(configs)}_scanners",
        changes={"updated_count": len(configs)},
    )

    return ApiResponse(
        success=True,
        message=f"Successfully updated {len(configs)} scanner configurations",
        data={"updated_count": len(configs)}
    )


@router.post("/{scanner_id}/reset", response_model=ApiResponse)
async def reset_scanner_config(
    request: Request,
    scanner_id: str,
    application_id: UUID = Depends(get_application_id),
    db: Session = Depends(get_admin_db)
):
    """
    Reset scanner configuration to package defaults.

    This removes all overrides and re-enables the scanner.
    """
    current_user = get_current_user(request)
    service = ScannerConfigService(db)

    try:
        scanner_uuid = UUID(scanner_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid scanner ID format"
        )

    success = service.reset_scanner_config(
        application_id=application_id,
        scanner_id=scanner_uuid
    )

    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Scanner configuration not found"
        )

    logger.info(
        f"User {current_user['email']} reset scanner config to defaults: "
        f"app={application_id}, scanner={scanner_id}"
    )

    await log_operation(
        db=db, request=request, action="update",
        resource_type="scanner_config",
        resource_id=scanner_id,
        resource_name=f"reset_{scanner_id}",
        changes={"action": "reset_to_defaults"},
    )

    return ApiResponse(
        success=True,
        message="Scanner configuration reset to defaults"
    )


@router.post("/reset-all", response_model=ApiResponse)
async def reset_all_configs(
    request: Request,
    application_id: UUID = Depends(get_application_id),
    db: Session = Depends(get_admin_db)
):
    """
    Reset ALL scanner configurations to package defaults.

    ⚠️ Warning: This will remove all custom overrides!
    """
    current_user = get_current_user(request)
    service = ScannerConfigService(db)

    count = service.reset_all_configs(application_id)

    logger.warning(
        f"User {current_user['email']} reset ALL {count} scanner configs "
        f"to defaults for app={application_id}"
    )

    await log_operation(
        db=db, request=request, action="update",
        resource_type="scanner_config",
        resource_id=str(application_id),
        resource_name=f"reset_all_{count}_scanners",
        changes={"action": "reset_all_to_defaults", "reset_count": count},
    )

    return ApiResponse(
        success=True,
        message=f"Successfully reset {count} scanner configurations to defaults",
        data={"reset_count": count}
    )


@router.post("/initialize", response_model=ApiResponse)
async def initialize_default_configs(
    request: Request,
    application_id: UUID = Depends(get_application_id),
    db: Session = Depends(get_admin_db)
):
    """
    Initialize default configs for all available scanners.

    Useful when new scanners are added to packages or
    when application is newly created.
    """
    current_user = get_current_user(request)
    service = ScannerConfigService(db)
    tenant_id = UUID(current_user['tenant_id'])

    count = service.initialize_default_configs(
        application_id=application_id,
        tenant_id=tenant_id
    )

    logger.info(
        f"User {current_user['email']} initialized {count} default scanner configs "
        f"for app={application_id}"
    )

    await log_operation(
        db=db, request=request, action="create",
        resource_type="scanner_config",
        resource_id=str(application_id),
        resource_name=f"initialize_{count}_scanners",
        changes={"action": "initialize_defaults", "initialized_count": count},
    )

    return ApiResponse(
        success=True,
        message=f"Initialized {count} scanner configurations",
        data={"initialized_count": count}
    )
