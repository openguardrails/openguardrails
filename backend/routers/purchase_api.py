"""
Purchase API Router
Handles package purchase requests and approvals
"""

from typing import List, Optional
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, status, Request
from sqlalchemy.orm import Session

from database.connection import get_admin_db
from services.purchase_service import PurchaseService
from models.requests import PurchaseRequestCreate, PurchaseApprovalRequest
from models.responses import (
    PurchaseResponse, PurchasePendingResponse,
    PackageStatisticsResponse, ApiResponse
)
from utils.logger import setup_logger

logger = setup_logger()

router = APIRouter(prefix="/api/v1/purchases", tags=["Package Purchases"])


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



# =====================================================
# User Purchase Endpoints
# =====================================================

@router.post("/direct", response_model=PurchaseResponse, status_code=status.HTTP_201_CREATED)
async def direct_purchase_free_package(
    request: Request,
    request_data: PurchaseRequestCreate,
    db: Session = Depends(get_admin_db)
):
    """
    Directly purchase a free package (auto-approved, no admin review needed).
    
    This endpoint is used for packages with price = 0 or None.
    The purchase is immediately approved and the package becomes available.
    
    For paid packages, use the payment API instead.
    """
    current_user = get_current_user(request)
    service = PurchaseService(db)
    tenant_id = UUID(current_user['tenant_id'])

    try:
        package_id = UUID(request_data.package_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid package ID format"
        )

    try:
        purchase = service.direct_purchase_free_package(
            tenant_id=tenant_id,
            package_id=package_id,
            email=request_data.email
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )

    logger.info(
        f"User {current_user['email']} directly purchased free package: "
        f"package={package_id}"
    )

    # Get package info
    package = purchase.package

    return PurchaseResponse(
        id=str(purchase.id),
        package_id=str(purchase.package_id),
        package_name=package.package_name if package else None,
        package_code=package.package_code if package else None,
        status=purchase.status,
        request_email=purchase.request_email,
        request_message=purchase.request_message,
        rejection_reason=purchase.rejection_reason,
        approved_at=purchase.approved_at.isoformat() if purchase.approved_at else None,
        created_at=purchase.created_at.isoformat() if purchase.created_at else None
    )


@router.post("/request", response_model=PurchaseResponse, status_code=status.HTTP_201_CREATED)
async def request_purchase(
    request: Request,
    request_data: PurchaseRequestCreate,
    db: Session = Depends(get_admin_db)
):
    """
    Request to purchase a package (DEPRECATED - use payment API or direct purchase instead).

    Requirements:
    - Must be a subscribed user (free tier cannot purchase)
    - Package must exist and be purchasable
    - Cannot purchase same package twice

    Process:
    1. Submit purchase request with contact email and message
    2. Admin reviews request
    3. Admin approves or rejects
    4. If approved, package becomes available to tenant
    """
    current_user = get_current_user(request)
    service = PurchaseService(db)
    tenant_id = UUID(current_user['tenant_id'])

    try:
        package_id = UUID(request_data.package_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid package ID format"
        )

    try:
        purchase = service.request_purchase(
            tenant_id=tenant_id,
            package_id=package_id,
            email=request_data.email,
            message=request_data.message
        )
    except ValueError as e:
        # Handle validation errors (already purchased, not subscribed, etc.)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )

    logger.info(
        f"User {current_user['email']} requested purchase: "
        f"package={package_id}, email={request_data.email}"
    )

    # Get package info
    package = purchase.package

    return PurchaseResponse(
        id=str(purchase.id),
        package_id=str(purchase.package_id),
        package_name=package.package_name if package else None,
        package_code=package.package_code if package else None,
        status=purchase.status,
        request_email=purchase.request_email,
        request_message=purchase.request_message,
        rejection_reason=purchase.rejection_reason,
        approved_at=purchase.approved_at.isoformat() if purchase.approved_at else None,
        created_at=purchase.created_at.isoformat() if purchase.created_at else None
    )


@router.get("/my-purchases", response_model=List[PurchaseResponse])
async def get_my_purchases(
    request: Request,
    status_filter: Optional[str] = None,
    db: Session = Depends(get_admin_db)
):
    """
    Get current user's purchase requests.

    Query params:
    - status: Filter by status ('pending', 'approved', 'rejected')
    """
    current_user = get_current_user(request)

    if status_filter and status_filter not in ['pending', 'approved', 'rejected']:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="status must be 'pending', 'approved', or 'rejected'"
        )

    service = PurchaseService(db)
    tenant_id = UUID(current_user['tenant_id'])

    purchases = service.get_user_purchases(
        tenant_id=tenant_id,
        status=status_filter
    )

    result = [PurchaseResponse(**purchase) for purchase in purchases]

    logger.info(
        f"User {current_user['email']} retrieved {len(result)} purchase requests "
        f"(status={status_filter})"
    )

    return result


@router.delete("/{purchase_id}", response_model=ApiResponse)
async def cancel_purchase_request(
    request: Request,
    purchase_id: str,
    db: Session = Depends(get_admin_db)
):
    """
    Cancel own purchase request (only pending requests).
    """
    current_user = get_current_user(request)
    service = PurchaseService(db)
    tenant_id = UUID(current_user['tenant_id'])

    try:
        purchase_uuid = UUID(purchase_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid purchase ID format"
        )

    success = service.cancel_purchase_request(
        purchase_id=purchase_uuid,
        tenant_id=tenant_id
    )

    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Purchase request not found or cannot be cancelled"
        )

    logger.info(
        f"User {current_user['email']} cancelled purchase request {purchase_id}"
    )

    return ApiResponse(
        success=True,
        message="Purchase request cancelled successfully"
    )


# =====================================================
# Admin Purchase Management Endpoints
# =====================================================

@router.get("/admin/pending", response_model=List[PurchasePendingResponse])
async def get_pending_purchases(
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    Get all pending purchase requests (admin only).

    Returns requests ordered by creation time (oldest first).
    """
    current_user = require_super_admin(request)
    service = PurchaseService(db)

    purchases = service.get_pending_purchases()

    result = [PurchasePendingResponse(**purchase) for purchase in purchases]

    logger.info(
        f"Admin {current_user['email']} retrieved {len(result)} pending purchase requests"
    )

    return result


@router.post("/admin/{purchase_id}/approve", response_model=PurchaseResponse)
async def approve_purchase(
    request: Request,
    purchase_id: str,
    db: Session = Depends(get_admin_db)
):
    """
    Approve purchase request (admin only).

    After approval:
    - Package becomes available to tenant
    - Scanner definitions are accessible
    - Tenant can configure scanners in applications
    """
    current_user = require_super_admin(request)
    service = PurchaseService(db)
    admin_id = UUID(current_user['tenant_id'])

    try:
        purchase_uuid = UUID(purchase_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid purchase ID format"
        )

    try:
        purchase = service.approve_purchase(
            purchase_id=purchase_uuid,
            approved_by=admin_id
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )

    if not purchase:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Purchase request not found"
        )

    logger.warning(
        f"Admin {current_user['email']} approved purchase: "
        f"id={purchase_id}, tenant={purchase.tenant_id}, "
        f"package={purchase.package_id}"
    )

    # Get package info
    package = purchase.package

    return PurchaseResponse(
        id=str(purchase.id),
        package_id=str(purchase.package_id),
        package_name=package.package_name if package else None,
        package_code=package.package_code if package else None,
        status=purchase.status,
        request_email=purchase.request_email,
        request_message=purchase.request_message,
        rejection_reason=purchase.rejection_reason,
        approved_at=purchase.approved_at.isoformat() if purchase.approved_at else None,
        created_at=purchase.created_at.isoformat() if purchase.created_at else None
    )


@router.post("/admin/{purchase_id}/reject", response_model=PurchaseResponse)
async def reject_purchase(
    request: Request,
    purchase_id: str,
    rejection_data: PurchaseApprovalRequest,
    db: Session = Depends(get_admin_db)
):
    """
    Reject purchase request (admin only).

    Requires rejection reason.
    User can re-request if rejected.
    """
    current_user = require_super_admin(request)
    service = PurchaseService(db)
    admin_id = UUID(current_user['tenant_id'])

    if not rejection_data.rejection_reason:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Rejection reason is required"
        )

    try:
        purchase_uuid = UUID(purchase_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid purchase ID format"
        )

    try:
        purchase = service.reject_purchase(
            purchase_id=purchase_uuid,
            rejection_reason=rejection_data.rejection_reason,
            rejected_by=admin_id
        )
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )

    if not purchase:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Purchase request not found"
        )

    logger.warning(
        f"Admin {current_user['email']} rejected purchase: "
        f"id={purchase_id}, tenant={purchase.tenant_id}, "
        f"reason={rejection_data.rejection_reason}"
    )

    # Get package info
    package = purchase.package

    return PurchaseResponse(
        id=str(purchase.id),
        package_id=str(purchase.package_id),
        package_name=package.package_name if package else None,
        package_code=package.package_code if package else None,
        status=purchase.status,
        request_email=purchase.request_email,
        request_message=purchase.request_message,
        rejection_reason=purchase.rejection_reason,
        approved_at=purchase.approved_at.isoformat() if purchase.approved_at else None,
        created_at=purchase.created_at.isoformat() if purchase.created_at else None
    )


@router.get("/admin/statistics", response_model=ApiResponse)
async def get_purchase_statistics(
    request: Request,
    package_id: Optional[str] = None,
    db: Session = Depends(get_admin_db)
):
    """
    Get purchase statistics (admin only).

    Query params:
    - package_id: Filter by specific package (optional)
    """
    current_user = require_super_admin(request)
    service = PurchaseService(db)

    package_uuid = None
    if package_id:
        try:
            package_uuid = UUID(package_id)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid package ID format"
            )

    stats = service.get_purchase_statistics(package_id=package_uuid)

    logger.info(
        f"Admin {current_user['email']} retrieved purchase statistics "
        f"(package={package_id})"
    )

    return ApiResponse(
        success=True,
        message="Purchase statistics retrieved successfully",
        data=stats
    )
