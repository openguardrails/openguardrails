"""
Custom Scanner API Router
Handles user-defined custom scanners (S100+)
"""

from typing import List, Optional
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, status, Header, Request
from sqlalchemy.orm import Session

from database.connection import get_db
from services.custom_scanner_service import CustomScannerService
from models.requests import CustomScannerCreateRequest, CustomScannerUpdateRequest
from models.responses import CustomScannerResponse, ApiResponse
from utils.logger import setup_logger

logger = setup_logger()

router = APIRouter(prefix="/api/v1/custom-scanners", tags=["Custom Scanners"])


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
# Custom Scanner CRUD Endpoints
# =====================================================

@router.get("", response_model=List[CustomScannerResponse])
async def get_custom_scanners(
    request: Request,
    application_id: UUID = Depends(get_application_id),
    db: Session = Depends(get_db)
):
    """
    Get all custom scanners for application.

    Returns only active custom scanners (S100+) created by this application.
    """
    current_user = get_current_user(request)
    service = CustomScannerService(db)

    scanners = service.get_custom_scanners(application_id)

    result = [CustomScannerResponse(**scanner) for scanner in scanners]

    logger.info(
        f"User {current_user['email']} retrieved {len(result)} custom scanners "
        f"for app={application_id}"
    )

    return result


@router.get("/{scanner_id}", response_model=CustomScannerResponse)
async def get_custom_scanner(
    request: Request,
    scanner_id: str,
    application_id: UUID = Depends(get_application_id),
    db: Session = Depends(get_db)
):
    """
    Get custom scanner details by ID.
    """
    current_user = get_current_user(request)
    service = CustomScannerService(db)

    try:
        scanner_uuid = UUID(scanner_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid scanner ID format"
        )

    scanner = service.get_custom_scanner(
        scanner_id=scanner_uuid,
        application_id=application_id
    )

    if not scanner:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Custom scanner not found"
        )

    logger.info(
        f"User {current_user['email']} retrieved custom scanner {scanner_id}"
    )

    return CustomScannerResponse(**scanner)


@router.post("", response_model=CustomScannerResponse, status_code=status.HTTP_201_CREATED)
async def create_custom_scanner(
    request: Request,
    scanner_data: CustomScannerCreateRequest,
    application_id: UUID = Depends(get_application_id),
    db: Session = Depends(get_db)
):
    """
    Create a new custom scanner.

    Features:
    - Auto-assigned tag (S100, S101, S102, ...)
    - Validates scanner type (genai, regex, keyword)
    - Validates risk level (high_risk, medium_risk, low_risk)
    - No limits on number of custom scanners

    Scanner types:
    - genai: Calls OpenGuardrails-Text model
    - regex: Python regex pattern matching
    - keyword: Case-insensitive keyword matching
    """
    current_user = get_current_user(request)
    service = CustomScannerService(db)
    tenant_id = UUID(current_user['tenant_id'])

    scanner_dict = scanner_data.model_dump()

    try:
        scanner = service.create_custom_scanner(
            application_id=application_id,
            tenant_id=tenant_id,
            scanner_data=scanner_dict
        )
    except ValueError as e:
        # Handle validation errors
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )

    logger.info(
        f"User {current_user['email']} created custom scanner: "
        f"{scanner['tag']} ({scanner['name']}) type={scanner['scanner_type']} "
        f"for app={application_id}"
    )

    return CustomScannerResponse(**scanner)


@router.put("/{scanner_id}", response_model=CustomScannerResponse)
async def update_custom_scanner(
    request: Request,
    scanner_id: str,
    updates: CustomScannerUpdateRequest,
    application_id: UUID = Depends(get_application_id),
    db: Session = Depends(get_db)
):
    """
    Update custom scanner.

    Note: Cannot update scanner_type or tag (would break detection logic).
    Can update: name, description, definition, risk_level, scan_prompt, scan_response, notes
    """
    current_user = get_current_user(request)
    service = CustomScannerService(db)

    try:
        scanner_uuid = UUID(scanner_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid scanner ID format"
        )

    update_dict = updates.model_dump(exclude_unset=True)

    scanner = service.update_custom_scanner(
        scanner_id=scanner_uuid,
        application_id=application_id,
        updates=update_dict
    )

    if not scanner:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Custom scanner not found"
        )

    logger.info(
        f"User {current_user['email']} updated custom scanner {scanner_id}, "
        f"fields: {list(update_dict.keys())}"
    )

    return CustomScannerResponse(**scanner)


@router.delete("/{scanner_id}", response_model=ApiResponse)
async def delete_custom_scanner(
    request: Request,
    scanner_id: str,
    application_id: UUID = Depends(get_application_id),
    db: Session = Depends(get_db)
):
    """
    Delete custom scanner (soft delete).

    This will mark the scanner as inactive and cascade disable
    in all scanner configurations.
    """
    current_user = get_current_user(request)
    service = CustomScannerService(db)

    try:
        scanner_uuid = UUID(scanner_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid scanner ID format"
        )

    success = service.delete_custom_scanner(
        scanner_id=scanner_uuid,
        application_id=application_id
    )

    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Custom scanner not found"
        )

    logger.warning(
        f"User {current_user['email']} deleted custom scanner {scanner_id} "
        f"from app={application_id}"
    )

    return ApiResponse(
        success=True,
        message="Custom scanner deleted successfully"
    )


# =====================================================
# Utility Endpoints
# =====================================================

