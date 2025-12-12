"""
Purchase Service
Handles scanner package purchase requests and approvals
"""

from typing import List, Optional, Dict, Any
from uuid import UUID
from datetime import datetime
from sqlalchemy.orm import Session

from database.models import (
    PackagePurchase, ScannerPackage, Tenant, TenantSubscription, Application
)
from utils.logger import setup_logger
from services.response_template_service import ResponseTemplateService

logger = setup_logger()


class PurchaseService:
    """Service for managing package purchases"""

    def __init__(self, db: Session):
        self.db = db

    def request_purchase(
        self,
        tenant_id: UUID,
        package_id: UUID,
        email: str,
        message: Optional[str] = None
    ) -> PackagePurchase:
        """
        Request to purchase a premium package.

        Args:
            tenant_id: Tenant UUID
            package_id: Package UUID
            email: Contact email
            message: Optional purchase request message

        Returns:
            Purchase request

        Raises:
            ValueError: If package not found, not premium (purchasable), or already purchased
        """
        # Check if tenant is super admin - they don't need to purchase
        tenant = self.db.query(Tenant).filter(Tenant.id == tenant_id).first()
        is_super_admin = tenant and hasattr(tenant, 'is_super_admin') and tenant.is_super_admin
        
        if is_super_admin:
            raise ValueError(
                "Super admins have automatic access to all packages and do not need to purchase them."
            )
        
        # Verify package exists and is premium (purchasable)
        package = self.db.query(ScannerPackage).filter(
            ScannerPackage.id == package_id,
            ScannerPackage.is_active == True
        ).first()

        if not package:
            raise ValueError("Package not found")

        if not package.requires_purchase:
            raise ValueError("Package does not require purchase (it's free)")

        # Check if already purchased or requested
        existing = self.db.query(PackagePurchase).filter(
            PackagePurchase.tenant_id == tenant_id,
            PackagePurchase.package_id == package_id
        ).first()

        if existing:
            if existing.status == 'approved':
                raise ValueError("Package already purchased")
            elif existing.status == 'pending':
                raise ValueError("Purchase request already pending")
            elif existing.status == 'rejected':
                # Allow re-request if previously rejected
                existing.status = 'pending'
                existing.request_email = email
                existing.request_message = message
                existing.rejection_reason = None
                self.db.commit()
                self.db.refresh(existing)
                logger.info(
                    f"Re-requested purchase: tenant={tenant_id}, package={package_id}"
                )
                return existing

        # Check subscription requirement (only subscribed users can purchase)
        subscription = self.db.query(TenantSubscription).filter(
            TenantSubscription.tenant_id == tenant_id
        ).first()

        if not subscription or subscription.subscription_type != 'subscribed':
            raise ValueError(
                "Only subscribed users can purchase packages. "
                "Please upgrade to subscribed plan first."
            )

        # Create purchase request
        purchase = PackagePurchase(
            tenant_id=tenant_id,
            package_id=package_id,
            status='pending',
            request_email=email,
            request_message=message
        )
        self.db.add(purchase)
        self.db.commit()
        self.db.refresh(purchase)

        logger.info(
            f"Created purchase request: tenant={tenant_id}, "
            f"package={package.package_name}, email={email}"
        )

        return purchase

    def get_user_purchases(
        self,
        tenant_id: UUID,
        status: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """
        Get user's purchase requests.

        Args:
            tenant_id: Tenant UUID
            status: Filter by status ('pending', 'approved', 'rejected')

        Returns:
            List of purchase dicts
        """
        query = self.db.query(PackagePurchase).filter(
            PackagePurchase.tenant_id == tenant_id
        )

        if status:
            query = query.filter(PackagePurchase.status == status)

        purchases = query.order_by(PackagePurchase.created_at.desc()).all()

        result = []
        for purchase in purchases:
            package = purchase.package
            result.append({
                'id': str(purchase.id),
                'package_id': str(purchase.package_id),
                'package_name': package.package_name if package else None,
                'package_code': package.package_code if package else None,
                'status': purchase.status,
                'request_email': purchase.request_email,
                'request_message': purchase.request_message,
                'rejection_reason': purchase.rejection_reason,
                'approved_at': purchase.approved_at.isoformat() if purchase.approved_at else None,
                'created_at': purchase.created_at.isoformat() if purchase.created_at else None
            })

        return result

    def get_pending_purchases(self) -> List[Dict[str, Any]]:
        """
        Get all pending purchase requests (admin only).

        Returns:
            List of pending purchase dicts
        """
        purchases = self.db.query(PackagePurchase).filter(
            PackagePurchase.status == 'pending'
        ).order_by(PackagePurchase.created_at.asc()).all()

        result = []
        for purchase in purchases:
            package = purchase.package
            tenant = purchase.tenant
            result.append({
                'id': str(purchase.id),
                'tenant_id': str(purchase.tenant_id),
                'tenant_email': tenant.email if tenant else None,
                'package_id': str(purchase.package_id),
                'package_name': package.package_name if package else None,
                'package_code': package.package_code if package else None,
                'request_email': purchase.request_email,
                'request_message': purchase.request_message,
                'created_at': purchase.created_at.isoformat() if purchase.created_at else None
            })

        return result

    def approve_purchase(
        self,
        purchase_id: UUID,
        approved_by: UUID
    ) -> Optional[PackagePurchase]:
        """
        Approve purchase request (admin only).

        Args:
            purchase_id: Purchase UUID
            approved_by: Admin user UUID

        Returns:
            Approved purchase or None
        """
        purchase = self.db.query(PackagePurchase).filter(
            PackagePurchase.id == purchase_id
        ).first()

        if not purchase:
            return None

        if purchase.status != 'pending':
            raise ValueError(f"Purchase is not pending (status: {purchase.status})")

        purchase.status = 'approved'
        purchase.approved_by = approved_by
        purchase.approved_at = datetime.utcnow()
        purchase.rejection_reason = None

        self.db.commit()
        self.db.refresh(purchase)

        logger.info(
            f"Approved purchase: id={purchase_id}, tenant={purchase.tenant_id}, "
            f"package={purchase.package_id}, approved_by={approved_by}"
        )

        # Auto-create response templates for all scanners in this package
        # for all applications owned by this tenant
        try:
            self._create_templates_for_purchased_scanners(
                purchase=purchase,
                tenant_id=purchase.tenant_id
            )
        except Exception as e:
            logger.error(
                f"Failed to create response templates for purchase {purchase_id}: {e}"
            )

        return purchase

    def reject_purchase(
        self,
        purchase_id: UUID,
        rejection_reason: str,
        rejected_by: UUID
    ) -> Optional[PackagePurchase]:
        """
        Reject purchase request (admin only).

        Args:
            purchase_id: Purchase UUID
            rejection_reason: Reason for rejection
            rejected_by: Admin user UUID

        Returns:
            Rejected purchase or None
        """
        purchase = self.db.query(PackagePurchase).filter(
            PackagePurchase.id == purchase_id
        ).first()

        if not purchase:
            return None

        if purchase.status != 'pending':
            raise ValueError(f"Purchase is not pending (status: {purchase.status})")

        purchase.status = 'rejected'
        purchase.rejection_reason = rejection_reason
        purchase.approved_by = rejected_by  # Track who rejected
        purchase.approved_at = datetime.utcnow()  # Track when rejected

        self.db.commit()
        self.db.refresh(purchase)

        logger.warning(
            f"Rejected purchase: id={purchase_id}, tenant={purchase.tenant_id}, "
            f"package={purchase.package_id}, reason={rejection_reason}, rejected_by={rejected_by}"
        )

        return purchase

    def cancel_purchase_request(
        self,
        purchase_id: UUID,
        tenant_id: UUID
    ) -> bool:
        """
        Cancel own purchase request (user).

        Args:
            purchase_id: Purchase UUID
            tenant_id: Tenant UUID (must own the purchase)

        Returns:
            True if cancelled, False if not found or unauthorized
        """
        purchase = self.db.query(PackagePurchase).filter(
            PackagePurchase.id == purchase_id,
            PackagePurchase.tenant_id == tenant_id,
            PackagePurchase.status == 'pending'
        ).first()

        if not purchase:
            return False

        self.db.delete(purchase)
        self.db.commit()

        logger.info(
            f"Cancelled purchase request: id={purchase_id}, tenant={tenant_id}"
        )

        return True

    def _create_templates_for_purchased_scanners(
        self,
        purchase: PackagePurchase,
        tenant_id: UUID
    ):
        """
        Create response templates for all scanners in a purchased package,
        for all applications owned by the tenant.

        Args:
            purchase: PackagePurchase object
            tenant_id: Tenant UUID
        """
        # Get all applications owned by this tenant
        applications = self.db.query(Application).filter(
            Application.tenant_id == tenant_id,
            Application.is_active == True
        ).all()

        if not applications:
            logger.info(f"No active applications found for tenant {tenant_id}")
            return

        # Get all scanners in the purchased package
        package = purchase.package
        if not package or not package.scanners:
            logger.warning(f"No scanners found in package {purchase.package_id}")
            return

        template_service = ResponseTemplateService(self.db)

        # Create templates for each scanner in each application
        for app in applications:
            for scanner in package.scanners:
                if not scanner.is_active:
                    continue

                try:
                    template_service.create_template_for_marketplace_scanner(
                        scanner=scanner,
                        application_id=app.id,
                        tenant_id=tenant_id
                    )
                except Exception as e:
                    logger.error(
                        f"Failed to create template for scanner {scanner.tag} "
                        f"in app {app.id}: {e}"
                    )

    def direct_purchase_free_package(
        self,
        tenant_id: UUID,
        package_id: UUID,
        email: str
    ) -> PackagePurchase:
        """
        Directly purchase a free premium package without approval (auto-approved).
        Used for premium packages with price = 0 or None.

        Args:
            tenant_id: Tenant UUID
            package_id: Package UUID
            email: Contact email

        Returns:
            Approved purchase record

        Raises:
            ValueError: If package not found, not free, or already purchased
        """
        # Verify package exists and is free
        package = self.db.query(ScannerPackage).filter(
            ScannerPackage.id == package_id,
            ScannerPackage.is_active == True
        ).first()

        if not package:
            raise ValueError("Package not found")

        # Check if package is free
        if package.price and package.price > 0:
            raise ValueError("Package is not free. Please use payment flow.")

        # Check if already purchased
        existing = self.db.query(PackagePurchase).filter(
            PackagePurchase.tenant_id == tenant_id,
            PackagePurchase.package_id == package_id
        ).first()

        if existing:
            if existing.status == 'approved':
                raise ValueError("Package already purchased")
            else:
                # If somehow there's a pending/rejected record, update it to approved
                existing.status = 'approved'
                existing.request_email = email
                existing.approved_at = datetime.utcnow()
                self.db.commit()
                self.db.refresh(existing)
                logger.info(f"Updated existing purchase to approved: tenant={tenant_id}, package={package_id}")
                return existing

        # Create auto-approved purchase record
        purchase = PackagePurchase(
            tenant_id=tenant_id,
            package_id=package_id,
            status='approved',  # Auto-approved for free packages
            request_email=email,
            approved_at=datetime.utcnow()
        )
        self.db.add(purchase)
        self.db.commit()
        self.db.refresh(purchase)

        logger.info(
            f"Direct purchase completed (free package): tenant={tenant_id}, "
            f"package={package.package_name}, email={email}"
        )

        # Auto-create response templates
        try:
            self._create_templates_for_purchased_scanners(
                purchase=purchase,
                tenant_id=tenant_id
            )
        except Exception as e:
            logger.error(
                f"Failed to create response templates for purchase {purchase.id}: {e}"
            )

        return purchase

    def get_purchase_statistics(
        self,
        package_id: Optional[UUID] = None
    ) -> Dict[str, Any]:
        """
        Get purchase statistics (admin only).

        Args:
            package_id: Optional package filter

        Returns:
            Statistics dict
        """
        query = self.db.query(PackagePurchase)

        if package_id:
            query = query.filter(PackagePurchase.package_id == package_id)

        all_purchases = query.all()

        total = len(all_purchases)
        pending = sum(1 for p in all_purchases if p.status == 'pending')
        approved = sum(1 for p in all_purchases if p.status == 'approved')
        rejected = sum(1 for p in all_purchases if p.status == 'rejected')

        stats = {
            'total_requests': total,
            'pending': pending,
            'approved': approved,
            'rejected': rejected,
            'approval_rate': round(approved / total * 100, 2) if total > 0 else 0
        }

        if package_id:
            package = self.db.query(ScannerPackage).filter(
                ScannerPackage.id == package_id
            ).first()
            if package:
                stats['package_name'] = package.package_name
                stats['package_code'] = package.package_code

        return stats
