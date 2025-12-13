"""
Scanner Package API Router
Handles package listing, marketplace, and admin package management
"""

from typing import List, Optional
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, status, Request
from sqlalchemy.orm import Session

from database.connection import get_admin_db
from database.models import ScannerPackage
from services.scanner_package_service import ScannerPackageService
from models.requests import PackageUploadRequest, PackageUpdateRequest
from models.responses import (
    PackageResponse, PackageDetailResponse, MarketplacePackageResponse,
    PackageStatisticsResponse, ApiResponse
)
from utils.logger import setup_logger
from config import settings

logger = setup_logger()

router = APIRouter(prefix="/api/v1/scanner-packages", tags=["Scanner Packages"])


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
# User Endpoints - Package Viewing
# =====================================================

@router.get("/", response_model=List[PackageResponse])
async def get_all_packages(
    request: Request,
    package_type: Optional[str] = None,
    db: Session = Depends(get_admin_db)
):
    current_user = get_current_user(request)
    """
    Get all packages visible to current user.

    - Basic packages: Always visible (system-provided)
    - Premium packages: Only if purchased (SaaS mode only)

    Query params:
    - package_type: Filter by 'builtin' or 'purchasable' (basic/premium)

    Note: In enterprise mode, only basic packages are available.
    """
    service = ScannerPackageService(db)
    tenant_id = UUID(current_user['tenant_id'])

    # In enterprise mode, force package_type to 'builtin'
    if settings.is_enterprise_mode:
        package_type = 'builtin'

    packages = service.get_all_packages(
        tenant_id=tenant_id,
        package_type=package_type,
        include_scanners=False
    )

    # Convert to response models
    result = []
    for package in packages:
        result.append(PackageResponse(
            id=str(package.id),
            package_code=package.package_code,
            package_name=package.package_name,
            author=package.author,
            description=package.description,
            version=package.version,
            license=package.license,
            package_type=package.package_type,
            scanner_count=package.scanner_count,
            price=package.price,
            price_display=package.price_display,
            bundle=package.bundle,
            created_at=package.created_at.isoformat() if package.created_at else None,
            updated_at=package.updated_at.isoformat() if package.updated_at else None
        ))

    logger.info(f"User {current_user['email']} retrieved {len(result)} packages")
    return result


@router.get("/{package_id}", response_model=PackageDetailResponse)
async def get_package_detail(
    package_id: str,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    current_user = get_current_user(request)
    """
    Get package details including scanner definitions.

    Access control:
    - Builtin: Always accessible
    - Purchasable: Only if purchased
    """
    service = ScannerPackageService(db)
    tenant_id = UUID(current_user['tenant_id'])

    try:
        package_uuid = UUID(package_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid package ID format"
        )

    package_detail = service.get_package_detail(
        package_id=package_uuid,
        tenant_id=tenant_id
    )

    if not package_detail:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Package not found or access denied"
        )

    logger.info(
        f"User {current_user['email']} accessed package {package_detail['package_name']}"
    )

    return PackageDetailResponse(**package_detail)


# =====================================================
# Marketplace Endpoints
# =====================================================

@router.get("/marketplace/list", response_model=List[MarketplacePackageResponse])
async def get_marketplace_packages(
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    Get all premium packages (marketplace view).

    Returns metadata only (no scanner definitions until purchased).
    Includes purchase status for current user.

    Note: Only available in SaaS mode.
    """
    if settings.is_enterprise_mode:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Marketplace is not available in enterprise deployment mode"
        )

    current_user = get_current_user(request)
    service = ScannerPackageService(db)
    tenant_id = UUID(current_user['tenant_id'])

    packages = service.get_purchasable_packages(tenant_id)

    result = [MarketplacePackageResponse(**pkg) for pkg in packages]

    logger.info(
        f"User {current_user['email']} viewed marketplace "
        f"({len(result)} packages)"
    )

    return result


@router.get("/marketplace/{package_id}", response_model=PackageDetailResponse)
async def get_marketplace_package_detail(
    package_id: str,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    Get package preview for marketplace (no purchase required).

    Shows:
    - Package metadata
    - Basic scanner info (tag, name, type, risk level)
    - NO sensitive scanner definitions (for unpurchased packages)

    For purchased packages, returns full details.

    Note: Only available in SaaS mode.
    """
    if settings.is_enterprise_mode:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Marketplace is not available in enterprise deployment mode"
        )

    current_user = get_current_user(request)
    service = ScannerPackageService(db)
    tenant_id = UUID(current_user['tenant_id'])

    try:
        package_uuid = UUID(package_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid package ID format"
        )

    package_detail = service.get_marketplace_package_detail(
        package_id=package_uuid,
        tenant_id=tenant_id
    )

    if not package_detail:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Package not found"
        )

    logger.info(
        f"User {current_user['email']} viewed marketplace package {package_detail['package_name']}"
    )

    return PackageDetailResponse(**package_detail)


# =====================================================
# Admin Endpoints - Package Management
# =====================================================

@router.get("/admin/packages", response_model=List[PackageResponse])
async def get_all_packages_admin(
    request: Request,
    package_type: Optional[str] = None,
    include_archived: Optional[bool] = False,
    db: Session = Depends(get_admin_db),
    current_user: dict = Depends(require_super_admin)
):
    """
    Get all packages (admin only) - no purchase filtering.

    Query params:
    - package_type: Filter by 'builtin' or 'purchasable' (basic/premium)
    - include_archived: Whether to include archived packages (default: False)
    """
    service = ScannerPackageService(db)
    packages = service.get_all_packages_admin(
        package_type=package_type,
        include_archived=include_archived
    )

    result = []
    for package in packages:
        result.append(PackageResponse(
            id=str(package.id),
            package_code=package.package_code,
            package_name=package.package_name,
            author=package.author,
            description=package.description,
            version=package.version,
            license=package.license,
            package_type=package.package_type,
            scanner_count=package.scanner_count,
            price=package.price,
            price_display=package.price_display,
            bundle=package.bundle,
            created_at=package.created_at.isoformat() if package.created_at else None,
            updated_at=package.updated_at.isoformat() if package.updated_at else None,
            archived=package.archived,
            archived_at=package.archived_at.isoformat() if package.archived_at else None,
            archive_reason=package.archive_reason
        ))

    logger.info(f"Admin {current_user['email']} retrieved {len(result)} packages (archived={include_archived})")
    return result


@router.post("/admin/upload", response_model=PackageResponse)
async def upload_premium_package(
    upload_request: PackageUploadRequest,
    request: Request,
    db: Session = Depends(get_admin_db),
    current_user: dict = Depends(require_super_admin)
):
    """
    Upload a new premium package (admin only).

    Request body:
    {
      "package_data": {
        "package_code": "...",
        "package_name": "...",
        "author": "...",
        "description": "...",
        "version": "...",
        "license": "...",
        "price_display": "...",
        "scanners": [...]
      },
      "price": 99.99,
      "language": "en"
    }
    """
    service = ScannerPackageService(db)
    admin_id = UUID(current_user['tenant_id'])

    # Store price and format display based on language
    package_data = upload_request.package_data.copy()

    # Store the original price as a number
    package_data['price'] = upload_request.price

    # Store bundle
    if upload_request.bundle:
        package_data['bundle'] = upload_request.bundle

    if upload_request.price is not None:
        # Format price based on language
        if isinstance(upload_request.price, float) and upload_request.price.is_integer():
            # Convert integer-valued float to int
            price = int(upload_request.price)
        else:
            price = upload_request.price

        if upload_request.language in ['zh']:
            # Chinese: use Yuan symbol (元)
            if isinstance(price, int):
                package_data['price_display'] = f"￥{price}元"
            else:
                package_data['price_display'] = f"￥{price}元"
        else:
            # Default to English: use Dollar symbol
            if isinstance(price, int):
                package_data['price_display'] = f"${price}"
            else:
                package_data['price_display'] = f"${price}"
    else:
        # No price specified - mark as free
        if upload_request.language in ['zh']:
            package_data['price_display'] = "免费"
        else:
            package_data['price_display'] = "Free"

    try:
        package = service.create_purchasable_package(
            package_data=package_data,
            created_by=admin_id
        )
    except ValueError as e:
        logger.error(f"ValueError in package upload: {str(e)}")
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(e)
        )
    except Exception as e:
        logger.error(f"Error uploading package: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to upload package: {str(e)}"
        )

    logger.warning(
        f"Admin {current_user['email']} uploaded package: {package.package_name} "
        f"({package.scanner_count} scanners)"
    )

    return PackageResponse(
        id=str(package.id),
        package_code=package.package_code,
        package_name=package.package_name,
        author=package.author,
        description=package.description,
        version=package.version,
        license=package.license,
        package_type=package.package_type,
        scanner_count=package.scanner_count,
        price=package.price,
        price_display=package.price_display,
        bundle=package.bundle,
        created_at=package.created_at.isoformat() if package.created_at else None,
        updated_at=package.updated_at.isoformat() if package.updated_at else None
    )


@router.put("/admin/{package_id}", response_model=PackageResponse)
async def update_package(
    package_id: str,
    updates: PackageUpdateRequest,
    request: Request,
    db: Session = Depends(get_admin_db),
    current_user: dict = Depends(require_super_admin)
):
    """
    Update package metadata (admin only).

    Cannot modify scanners (would break existing configs).
    """
    service = ScannerPackageService(db)

    try:
        package_uuid = UUID(package_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid package ID format"
        )

    update_dict = updates.model_dump(exclude_unset=True)

    package = service.update_package(
        package_id=package_uuid,
        updates=update_dict
    )

    if not package:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Package not found"
        )

    logger.warning(
        f"Admin {current_user['email']} updated package {package.package_name}, "
        f"fields: {list(update_dict.keys())}"
    )

    return PackageResponse(
        id=str(package.id),
        package_code=package.package_code,
        package_name=package.package_name,
        author=package.author,
        description=package.description,
        version=package.version,
        license=package.license,
        package_type=package.package_type,
        scanner_count=package.scanner_count,
        price=package.price,
        price_display=package.price_display,
        bundle=package.bundle,
        created_at=package.created_at.isoformat() if package.created_at else None,
        updated_at=package.updated_at.isoformat() if package.updated_at else None
    )


@router.post("/admin/{package_id}/archive", response_model=ApiResponse)
async def archive_package(
    package_id: str,
    request: Request,
    archive_data: Optional[dict] = None,
    db: Session = Depends(get_admin_db),
    current_user: dict = Depends(require_super_admin)
):
    """
    Archive package (admin only).

    Archives the package so it's no longer visible to users but preserves historical data.

    Request body (optional):
    {
        "reason": "Archive reason (optional)"
    }
    """
    service = ScannerPackageService(db)

    try:
        package_uuid = UUID(package_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid package ID format"
        )

    reason = None
    if archive_data:
        reason = archive_data.get('reason')

    success = service.archive_package(
        package_id=package_uuid,
        archived_by=UUID(current_user['tenant_id']),
        reason=reason
    )

    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Package not found"
        )

    logger.warning(
        f"Admin {current_user['email']} archived package {package_id}"
    )

    return ApiResponse(
        success=True,
        message="Package archived successfully"
    )


@router.post("/admin/{package_id}/unarchive", response_model=ApiResponse)
async def unarchive_package(
    package_id: str,
    request: Request,
    db: Session = Depends(get_admin_db),
    current_user: dict = Depends(require_super_admin)
):
    """
    Unarchive package (admin only).

    Makes the package visible again.
    """
    service = ScannerPackageService(db)

    try:
        package_uuid = UUID(package_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid package ID format"
        )

    success = service.unarchive_package(
        package_id=package_uuid,
        unarchived_by=UUID(current_user['tenant_id'])
    )

    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Package not found or not archived"
        )

    logger.info(
        f"Admin {current_user['email']} unarchived package {package_id}"
    )

    return ApiResponse(
        success=True,
        message="Package unarchived successfully"
    )


@router.delete("/admin/{package_id}", response_model=ApiResponse)
async def delete_package(
    package_id: str,
    request: Request,
    db: Session = Depends(get_admin_db),
    current_user: dict = Depends(require_super_admin)
):
    """
    Archive package (equivalent to archive - backward compatibility).

    Legacy endpoint that archives the package.
    """
    service = ScannerPackageService(db)

    try:
        package_uuid = UUID(package_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid package ID format"
        )

    success = service.archive_package(
        package_id=package_uuid,
        archived_by=UUID(current_user['tenant_id']),
        reason="Legacy delete operation"
    )

    if not success:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Package not found"
        )

    logger.warning(
        f"Admin {current_user['email']} archived package {package_id} (legacy delete)"
    )

    return ApiResponse(
        success=True,
        message="Package archived (legacy delete)"
    )


@router.get("/admin/{package_id}/statistics", response_model=PackageStatisticsResponse)
async def get_package_statistics(
    package_id: str,
    request: Request,
    db: Session = Depends(get_admin_db),
    current_user: dict = Depends(require_super_admin)
):
    """
    Get package purchase statistics (admin only).
    """
    service = ScannerPackageService(db)

    try:
        package_uuid = UUID(package_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid package ID format"
        )

    stats = service.get_package_statistics(package_uuid)

    if not stats:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Package not found"
        )

    logger.info(
        f"Admin {current_user['email']} viewed statistics for package {package_id}"
    )

    return PackageStatisticsResponse(**stats)
