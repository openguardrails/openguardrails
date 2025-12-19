"""
Scanner Package Service
Handles CRUD operations for scanner packages
"""

import json
from typing import List, Optional, Dict, Any
from uuid import UUID
from sqlalchemy.orm import Session
from sqlalchemy import or_, func

from database.models import (
    ScannerPackage, Scanner, PackagePurchase, Tenant
)
from utils.logger import setup_logger

logger = setup_logger()


class ScannerPackageService:
    """Service for managing scanner packages"""

    def __init__(self, db: Session):
        self.db = db

    def _normalize_risk_level(self, risk_level: str) -> str:
        """
        Normalize risk level to match database constraint.

        Args:
            risk_level: Risk level from package JSON ('high', 'medium', 'low')

        Returns:
            Normalized risk level ('high_risk', 'medium_risk', 'low_risk')
        """
        risk_mapping = {
            'high': 'high_risk',
            'medium': 'medium_risk',
            'low': 'low_risk',
            'high_risk': 'high_risk',
            'medium_risk': 'medium_risk',
            'low_risk': 'low_risk'
        }

        result = risk_mapping.get(risk_level, 'medium_risk')
        if result != risk_level:
            logger.info(f"Normalized risk level '{risk_level}' to '{result}'")

        if result not in ['high_risk', 'medium_risk', 'low_risk']:
            logger.warning(f"Invalid risk level '{risk_level}', defaulting to 'medium_risk'")
            return 'medium_risk'

        return result

    def get_all_packages(
        self,
        tenant_id: UUID,
        package_type: Optional[str] = None,
        include_scanners: bool = False
    ) -> List[ScannerPackage]:
        """
        Get all packages visible to tenant.

        Args:
            tenant_id: Tenant UUID
            package_type: Filter by type ('basic', 'purchasable') - basic/premium packages
            include_scanners: Whether to eagerly load scanners

        Returns:
            List of visible packages
        """
        # Check if tenant is super admin - they get access to all packages
        tenant = self.db.query(Tenant).filter(Tenant.id == tenant_id).first()
        is_super_admin = tenant and hasattr(tenant, 'is_super_admin') and tenant.is_super_admin
        
        query = self.db.query(ScannerPackage).filter(
            ScannerPackage.is_active == True,
            ScannerPackage.archived == False
        )

        if package_type:
            query = query.filter(ScannerPackage.package_type == package_type)

        packages = query.order_by(
            ScannerPackage.display_order,
            ScannerPackage.package_name
        ).all()

        # Filter premium packages (only show purchased ones, unless super admin)
        visible_packages = []
        for package in packages:
            if package.package_type == 'basic':  # Basic packages
                visible_packages.append(package)
            elif package.package_type == 'purchasable':  # Premium packages
                if is_super_admin:
                    # Super admin gets access to all packages
                    visible_packages.append(package)
                    logger.debug(f"Super admin granted access to premium package: {package.package_name}")
                else:
                    # Check if tenant has purchased
                    purchase = self.db.query(PackagePurchase).filter(
                        PackagePurchase.tenant_id == tenant_id,
                        PackagePurchase.package_id == package.id,
                        PackagePurchase.status == 'approved'
                    ).first()
                    if purchase:
                        visible_packages.append(package)

        return visible_packages

    def get_purchasable_packages(
        self,
        tenant_id: UUID
    ) -> List[Dict[str, Any]]:
        """
        Get premium packages with metadata (no scanner definitions).

        This prevents leaking paid package content before purchase.

        Args:
            tenant_id: Tenant UUID

        Returns:
            List of package metadata dicts
        """
        # Check if tenant is super admin - they automatically have access to all packages
        tenant = self.db.query(Tenant).filter(Tenant.id == tenant_id).first()
        is_super_admin = tenant and hasattr(tenant, 'is_super_admin') and tenant.is_super_admin
        
        packages = self.db.query(ScannerPackage).filter(
            ScannerPackage.package_type == 'purchasable',
            ScannerPackage.is_active == True,
            ScannerPackage.archived == False
        ).order_by(
            ScannerPackage.bundle.asc().nullslast(),
            ScannerPackage.display_order,
            ScannerPackage.package_name
        ).all()

        result = []
        for package in packages:
            # Super admins automatically have all packages "purchased"
            if is_super_admin:
                package_info = {
                    'id': str(package.id),
                    'package_code': package.package_code,
                    'package_name': package.package_name,
                    'author': package.author,
                    'description': package.description,
                    'version': package.version,
                    'package_type': package.package_type,
                    'scanner_count': package.scanner_count,
                    'price': package.price,
                    'price_display': package.price_display,
                    'bundle': package.bundle,
                    'purchase_status': 'approved',  # Super admin treated as approved
                    'purchased': True,  # Super admin has access to all packages
                    'purchase_requested': False,
                    'created_at': package.created_at.isoformat() if package.created_at else None
                }
                result.append(package_info)
                continue
            
            # Check purchase status for regular users
            purchase = self.db.query(PackagePurchase).filter(
                PackagePurchase.tenant_id == tenant_id,
                PackagePurchase.package_id == package.id
            ).first()

            package_info = {
                'id': str(package.id),
                'package_code': package.package_code,
                'package_name': package.package_name,
                'author': package.author,
                'description': package.description,
                'version': package.version,
                'package_type': package.package_type,
                'scanner_count': package.scanner_count,
                'price': package.price,
                'price_display': package.price_display,
                'bundle': package.bundle,
                'purchase_status': purchase.status if purchase else None,
                'purchased': bool(purchase and purchase.status == 'approved'),
                'purchase_requested': bool(purchase is not None),
                'created_at': package.created_at.isoformat() if package.created_at else None
            }
            result.append(package_info)

        return result

    def get_package_by_id(
        self,
        package_id: UUID,
        tenant_id: Optional[UUID] = None,
        check_access: bool = True
    ) -> Optional[ScannerPackage]:
        """
        Get package by ID.

        Args:
            package_id: Package UUID
            tenant_id: Tenant UUID (for access check)
            check_access: Whether to check tenant access

        Returns:
            Package or None
        """
        package = self.db.query(ScannerPackage).filter(
            ScannerPackage.id == package_id,
            ScannerPackage.is_active == True,
            ScannerPackage.archived == False
        ).first()

        if not package:
            return None

        # Check access for premium packages
        if check_access and tenant_id and package.package_type == 'purchasable':  # Premium packages
            # Check if tenant is super admin - they get access to all packages
            tenant = self.db.query(Tenant).filter(Tenant.id == tenant_id).first()
            is_super_admin = tenant and hasattr(tenant, 'is_super_admin') and tenant.is_super_admin
            
            if is_super_admin:
                logger.debug(f"Super admin granted access to premium package: {package.package_name}")
                return package
            
            # Regular users need to have purchased the package
            purchase = self.db.query(PackagePurchase).filter(
                PackagePurchase.tenant_id == tenant_id,
                PackagePurchase.package_id == package_id,
                PackagePurchase.status == 'approved'
            ).first()
            if not purchase:
                return None

        return package

    def get_package_detail(
        self,
        package_id: UUID,
        tenant_id: UUID
    ) -> Optional[Dict[str, Any]]:
        """
        Get package details including scanners.

        Only returns scanner definitions if:
        - Package is basic (builtin), OR
        - Tenant has purchased the premium package

        Args:
            package_id: Package UUID
            tenant_id: Tenant UUID

        Returns:
            Package detail dict or None
        """
        package = self.get_package_by_id(package_id, tenant_id, check_access=True)

        if not package:
            return None

        # Get scanners
        scanners = self.db.query(Scanner).filter(
            Scanner.package_id == package_id,
            Scanner.is_active == True
        ).order_by(Scanner.display_order, Scanner.tag).all()

        scanner_list = []
        for scanner in scanners:
            # Determine scan_target based on scan_prompt and scan_response
            if scanner.default_scan_prompt and scanner.default_scan_response:
                scan_target = 'both'
            elif scanner.default_scan_prompt:
                scan_target = 'prompt'
            elif scanner.default_scan_response:
                scan_target = 'response'
            else:
                scan_target = 'both'  # Default fallback

            # Map risk level format (remove _risk suffix if present for compatibility)
            risk_level = scanner.default_risk_level.replace('_risk', '') if scanner.default_risk_level else 'medium'

            scanner_list.append({
                'id': str(scanner.id),
                'scanner_tag': scanner.tag,  # Use scanner_tag to match frontend expectation
                'scanner_name': scanner.name,  # Use scanner_name to match frontend expectation
                'tag': scanner.tag,  # Keep original for backward compatibility
                'name': scanner.name,  # Keep original for backward compatibility
                'description': scanner.description,
                'scanner_type': scanner.scanner_type,
                'definition': scanner.definition,
                'risk_level': risk_level,  # Simplified risk level (high, medium, low)
                'default_risk_level': scanner.default_risk_level,  # Keep original
                'scan_target': scan_target,  # Derived from scan_prompt and scan_response
                'default_scan_prompt': scanner.default_scan_prompt,
                'default_scan_response': scanner.default_scan_response,
                'is_active': scanner.is_active
            })

        return {
            'id': str(package.id),
            'package_code': package.package_code,
            'package_name': package.package_name,
            'author': package.author,
            'description': package.description,
            'version': package.version,
            'license': package.license,
            'package_type': package.package_type,
            'scanner_count': len(scanner_list),
            'scanners': scanner_list,
            'created_at': package.created_at.isoformat() if package.created_at else None,
            'updated_at': package.updated_at.isoformat() if package.updated_at else None
        }

    def get_marketplace_package_detail(
        self,
        package_id: UUID,
        tenant_id: UUID
    ) -> Optional[Dict[str, Any]]:
        """
        Get package details for marketplace preview.

        - If package is basic (builtin) OR user has purchased: return full details
        - If package is premium (purchasable) and NOT purchased: return metadata + basic scanner info (no definitions)

        Args:
            package_id: Package UUID
            tenant_id: Tenant UUID

        Returns:
            Package detail dict or None
        """
        package = self.db.query(ScannerPackage).filter(
            ScannerPackage.id == package_id,
            ScannerPackage.is_active == True,
            ScannerPackage.archived == False
        ).first()

        if not package:
            return None

        # Check if tenant is super admin - they get full access to all packages
        tenant = self.db.query(Tenant).filter(Tenant.id == tenant_id).first()
        is_super_admin = tenant and hasattr(tenant, 'is_super_admin') and tenant.is_super_admin

        # Check if user has purchased (for premium packages)
        has_purchased = False
        if package.package_type == 'purchasable':  # Premium packages
            if is_super_admin:
                has_purchased = True
                logger.debug(f"Super admin granted full access to premium package: {package.package_name}")
            else:
                purchase = self.db.query(PackagePurchase).filter(
                    PackagePurchase.tenant_id == tenant_id,
                    PackagePurchase.package_id == package_id,
                    PackagePurchase.status == 'approved'
                ).first()
                has_purchased = bool(purchase)

        # Get scanners
        scanners = self.db.query(Scanner).filter(
            Scanner.package_id == package_id,
            Scanner.is_active == True
        ).order_by(Scanner.display_order, Scanner.tag).all()

        # Build scanner list
        scanner_list = []
        for scanner in scanners:
            # Determine scan_target based on scan_prompt and scan_response
            if scanner.default_scan_prompt and scanner.default_scan_response:
                scan_target = 'both'
            elif scanner.default_scan_prompt:
                scan_target = 'prompt'
            elif scanner.default_scan_response:
                scan_target = 'response'
            else:
                scan_target = 'both'  # Default fallback

            # Map risk level format (remove _risk suffix if present for compatibility)
            risk_level = scanner.default_risk_level.replace('_risk', '') if scanner.default_risk_level else 'medium'

            scanner_info = {
                'id': str(scanner.id),
                'scanner_tag': scanner.tag,  # Use scanner_tag to match frontend expectation
                'scanner_name': scanner.name,  # Use scanner_name to match frontend expectation
                'tag': scanner.tag,  # Keep original for backward compatibility
                'name': scanner.name,  # Keep original for backward compatibility
                'description': scanner.description,
                'scanner_type': scanner.scanner_type,
                'risk_level': risk_level,  # Simplified risk level (high, medium, low)
                'default_risk_level': scanner.default_risk_level,  # Keep original
                'scan_target': scan_target,  # Derived from scan_prompt and scan_response
                'default_scan_prompt': scanner.default_scan_prompt,
                'default_scan_response': scanner.default_scan_response,
                'is_active': scanner.is_active
            }

            # Only include definition if basic package or purchased premium package
            if package.package_type == 'basic' or has_purchased:  # Basic or purchased premium
                scanner_info['definition'] = scanner.definition
            else:
                # For unpurchased packages, hide the definition
                scanner_info['definition'] = None

            scanner_list.append(scanner_info)

        return {
            'id': str(package.id),
            'package_code': package.package_code,
            'package_name': package.package_name,
            'author': package.author,
            'description': package.description,
            'version': package.version,
            'license': package.license,
            'package_type': package.package_type,
            'scanner_count': len(scanner_list),
            'scanners': scanner_list,
            'price': package.price,
            'price_display': package.price_display,
            'created_at': package.created_at.isoformat() if package.created_at else None,
            'updated_at': package.updated_at.isoformat() if package.updated_at else None
        }

    def create_purchasable_package(
        self,
        package_data: Dict[str, Any],
        created_by: UUID
    ) -> ScannerPackage:
        """
        Create a new premium package or update existing version (admin only).

        Version update logic:
        - Same package_code + same version: raise error (duplicate)
        - Same package_code + different version: create new version
        - Package with same code exists and is active but not archived: raise error telling admin to archive first

        Args:
            package_data: Package data dict (from JSON file)
            created_by: Admin user UUID

        Returns:
            Created package
        """
        package_code = package_data['package_code']
        package_version = package_data.get('version', '1.0.0')

        # Check for exact duplicate (same code + same version)
        exact_duplicate = self.db.query(ScannerPackage).filter(
            ScannerPackage.package_code == package_code,
            ScannerPackage.version == package_version,
            ScannerPackage.is_active == True,
            ScannerPackage.archived == False
        ).first()

        if exact_duplicate:
            raise ValueError(
                f"Package with code '{package_code}' and version '{package_version}' already exists. "
                f"Use a different version number."
            )

        # Check for active packages with same code (different versions)
        active_packages = self.db.query(ScannerPackage).filter(
            ScannerPackage.package_code == package_code,
            ScannerPackage.is_active == True,
            ScannerPackage.archived == False
        ).all()

        if active_packages:
            # There are active packages with same code - admin should archive them first
            package_names = [f"{p.package_name} (v{p.version})" for p in active_packages]
            raise ValueError(
                f"Cannot create new version of '{package_code}' because the following "
                f"packages are still active: {', '.join(package_names)}. "
                f"Please archive the old version(s) first before uploading a new version."
            )

        # Create new package (no conflict with active packages)
        package = ScannerPackage(
            package_code=package_code,
            package_name=package_data['package_name'],
            author=package_data.get('author', 'OpenGuardrails'),
            description=package_data.get('description'),
            version=package_version,
            license=package_data.get('license', 'proprietary'),
            package_type='purchasable',
            is_official=True,
            requires_purchase=True,
            price=package_data.get('price'),
            price_display=package_data.get('price_display'),
            bundle=package_data.get('bundle'),
            scanner_count=len(package_data.get('scanners', []))
        )
        self.db.add(package)

        self.db.flush()

        # Create scanners - handle tag re-use for official packages
        for i, scanner_data in enumerate(package_data.get('scanners', [])):
            # Check if scanner with this tag already exists (from previous package version)
            existing_scanner = self.db.query(Scanner).filter(
                Scanner.tag == scanner_data['tag']
            ).first()

            if existing_scanner:
                # Reuse existing scanner record for official packages
                # Update the scanner to point to the new package and update its data
                existing_scanner.package_id = package.id
                existing_scanner.name = scanner_data['name']
                existing_scanner.description = scanner_data.get('description', scanner_data['definition'])
                existing_scanner.scanner_type = scanner_data['type']
                existing_scanner.definition = scanner_data['definition']
                existing_scanner.default_risk_level = self._normalize_risk_level(scanner_data['risk_level'])
                existing_scanner.default_scan_prompt = scanner_data.get('scan_prompt', True)
                existing_scanner.default_scan_response = scanner_data.get('scan_response', True)
                existing_scanner.display_order = i
                existing_scanner.is_active = True

                logger.info(f"Reused existing scanner tag {scanner_data['tag']} for new package version")
            else:
                # Create new scanner record if tag doesn't exist
                scanner = Scanner(
                    package_id=package.id,
                    tag=scanner_data['tag'],
                    name=scanner_data['name'],
                    description=scanner_data.get('description', scanner_data['definition']),
                    scanner_type=scanner_data['type'],
                    definition=scanner_data['definition'],
                    default_risk_level=self._normalize_risk_level(scanner_data['risk_level']),
                    default_scan_prompt=scanner_data.get('scan_prompt', True),
                    default_scan_response=scanner_data.get('scan_response', True),
                    display_order=i
                )
                self.db.add(scanner)
                logger.info(f"Created new scanner with tag {scanner_data['tag']}")

        self.db.commit()
        self.db.refresh(package)

        logger.info(
            f"Created purchasable package: {package.package_name} v{package.version} "
            f"({package.scanner_count} scanners) by {created_by}"
        )

        return package

    def update_package(
        self,
        package_id: UUID,
        updates: Dict[str, Any]
    ) -> Optional[ScannerPackage]:
        """
        Update package metadata (admin only).

        Args:
            package_id: Package UUID
            updates: Fields to update

        Returns:
            Updated package or None
        """
        package = self.db.query(ScannerPackage).filter(
            ScannerPackage.id == package_id
        ).first()

        if not package:
            return None

        # Update allowed fields
        allowed_fields = [
            'package_name', 'description', 'version', 'price', 'price_display',
            'bundle', 'is_active', 'display_order'
        ]

        for field in allowed_fields:
            if field in updates:
                setattr(package, field, updates[field])

        self.db.commit()
        self.db.refresh(package)

        logger.info(f"Updated package: {package.package_name} (ID: {package_id})")

        return package

    def archive_package(
        self,
        package_id: UUID,
        archived_by: UUID,
        reason: Optional[str] = None
    ) -> bool:
        """
        Archive package (admin only).

        Archives the package so it's no longer visible to users but preserves historical data.

        Args:
            package_id: Package UUID
            archived_by: Admin user UUID who is archiving
            reason: Optional reason for archiving

        Returns:
            True if archived, False if not found
        """
        package = self.db.query(ScannerPackage).filter(
            ScannerPackage.id == package_id
        ).first()

        if not package:
            return False

        if package.archived:
            logger.warning(f"Package {package.package_name} (ID: {package_id}) is already archived")
            return True

        package_name = package.package_name

        # Archive the package
        package.archived = True
        package.archived_at = func.now()
        package.archived_by = archived_by
        package.archive_reason = reason

        self.db.commit()

        logger.warning(
            f"Archived package: {package_name} (ID: {package_id}) "
            f"by admin {archived_by}. Reason: {reason or 'Not specified'}"
        )

        return True

    def unarchive_package(
        self,
        package_id: UUID,
        unarchived_by: UUID
    ) -> bool:
        """
        Unarchive package (admin only).

        Makes the package visible again.

        Args:
            package_id: Package UUID
            unarchived_by: Admin user UUID who is unarchiving

        Returns:
            True if unarchived, False if not found
        """
        package = self.db.query(ScannerPackage).filter(
            ScannerPackage.id == package_id,
            ScannerPackage.archived == True
        ).first()

        if not package:
            return False

        package_name = package.package_name

        # Unarchive the package
        package.archived = False
        package.archived_at = None
        package.archived_by = None
        package.archive_reason = None

        self.db.commit()

        logger.info(
            f"Unarchived package: {package_name} (ID: {package_id}) "
            f"by admin {unarchived_by}"
        )

        return True

    def get_all_packages_admin(
        self,
        package_type: Optional[str] = None,
        include_archived: bool = False
    ) -> List[ScannerPackage]:
        """
        Get all packages for admin with optional archive inclusion.

        Args:
            package_type: Filter by type ('basic', 'purchasable') - basic/premium packages
            include_archived: Whether to include archived packages

        Returns:
            List of packages
        """
        query = self.db.query(ScannerPackage).filter(
            ScannerPackage.is_active == True
        )

        if package_type:
            query = query.filter(ScannerPackage.package_type == package_type)

        if not include_archived:
            query = query.filter(ScannerPackage.archived == False)

        packages = query.order_by(
            ScannerPackage.package_code,
            ScannerPackage.version.desc()  # Newer versions first within same package
        ).all()

        return packages

    def get_package_statistics(
        self,
        package_id: UUID
    ) -> Optional[Dict[str, Any]]:
        """
        Get package statistics (admin only).

        Args:
            package_id: Package UUID

        Returns:
            Statistics dict or None
        """
        package = self.db.query(ScannerPackage).filter(
            ScannerPackage.id == package_id
        ).first()

        if not package:
            return None

        # Count purchases
        total_purchases = self.db.query(PackagePurchase).filter(
            PackagePurchase.package_id == package_id
        ).count()

        approved_purchases = self.db.query(PackagePurchase).filter(
            PackagePurchase.package_id == package_id,
            PackagePurchase.status == 'approved'
        ).count()

        pending_purchases = self.db.query(PackagePurchase).filter(
            PackagePurchase.package_id == package_id,
            PackagePurchase.status == 'pending'
        ).count()

        return {
            'package_id': str(package_id),
            'package_name': package.package_name,
            'total_purchases': total_purchases,
            'approved_purchases': approved_purchases,
            'pending_purchases': pending_purchases,
            'scanner_count': package.scanner_count
        }
