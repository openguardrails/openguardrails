"""
Scanner Configuration Service
Handles per-application scanner configuration management
"""

from typing import List, Optional, Dict, Any
from uuid import UUID
from sqlalchemy.orm import Session, selectinload
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import and_, select

from database.models import (
    ApplicationScannerConfig, Scanner, ScannerPackage,
    PackagePurchase, CustomScanner, Application, Tenant
)
from services.workspace_resolver import get_workspace_id_for_app, get_workspace_id_for_app_async
from utils.logger import setup_logger

logger = setup_logger()


class ScannerConfigService:
    """Service for managing application scanner configurations"""

    def __init__(self, db: Session):
        self.db = db

    def get_application_scanners(
        self,
        application_id: UUID,
        tenant_id: UUID,
        include_disabled: bool = True
    ) -> List[Dict[str, Any]]:
        """
        Get all scanners for application with user configs.

        Returns scanners from:
        1. Built-in packages (always available)
        2. Purchased packages (if tenant purchased)
        3. Custom scanners (if created by this application)

        Args:
            application_id: Application UUID
            tenant_id: Tenant UUID
            include_disabled: Whether to include disabled scanners

        Returns:
            List of scanner config dicts
        """
        # Resolve application_id → workspace_id
        workspace_id = get_workspace_id_for_app(self.db, str(application_id))

        # Get all available scanners
        available_scanners = self._get_available_scanners(tenant_id)
        custom_scanners = self._get_custom_scanners(application_id, workspace_id)

        all_scanners = available_scanners + custom_scanners

        # Get workspace-level configs (all config lives at workspace level)
        config_map = {}
        if workspace_id:
            ws_configs = self.db.query(ApplicationScannerConfig).filter(
                ApplicationScannerConfig.workspace_id == workspace_id,
                ApplicationScannerConfig.application_id.is_(None)
            ).all()
            config_map = {str(c.scanner_id): c for c in ws_configs}

        # Combine scanner definitions with configs
        result = []
        for scanner in all_scanners:
            config = config_map.get(str(scanner.id))

            # Determine effective settings
            is_enabled = config.is_enabled if config else True
            risk_level = (
                config.risk_level_override
                if config and config.risk_level_override
                else scanner.default_risk_level
            )
            scan_prompt = (
                config.scan_prompt_override
                if config and config.scan_prompt_override is not None
                else scanner.default_scan_prompt
            )
            scan_response = (
                config.scan_response_override
                if config and config.scan_response_override is not None
                else scanner.default_scan_response
            )

            # Skip if disabled and not including disabled
            if not include_disabled and not is_enabled:
                continue

            # Check if this is a custom scanner
            is_custom = hasattr(scanner, '_is_custom') and scanner._is_custom

            scanner_info = {
                'id': str(scanner.id),
                'tag': scanner.tag,
                'name': scanner.name,
                'description': scanner.description,
                'definition': scanner.definition,  # Scanner definition for detection
                'scanner_type': scanner.scanner_type,
                'package_name': scanner.package.package_name if scanner.package else 'Custom',
                'package_id': str(scanner.package_id) if scanner.package_id else None,
                'package_type': scanner.package.package_type if scanner.package else 'custom',  # 'builtin' (basic), 'purchasable' (premium), or 'custom'
                'is_custom': is_custom,

                # Effective settings (with overrides applied)
                'is_enabled': is_enabled,
                'risk_level': risk_level,
                'scan_prompt': scan_prompt,
                'scan_response': scan_response,

                # Default values (for UI to show)
                'default_risk_level': scanner.default_risk_level,
                'default_scan_prompt': scanner.default_scan_prompt,
                'default_scan_response': scanner.default_scan_response,

                # Override indicators
                'has_risk_level_override': config and config.risk_level_override is not None if config else False,
                'has_scan_prompt_override': config and config.scan_prompt_override is not None if config else False,
                'has_scan_response_override': config and config.scan_response_override is not None if config else False
            }
            result.append(scanner_info)

        return result

    def get_enabled_scanners(
        self,
        application_id: UUID,
        tenant_id: UUID,
        scan_type: Optional[str] = None  # 'prompt' or 'response'
    ) -> List[Dict[str, Any]]:
        """
        Get only enabled scanners for detection.

        Args:
            application_id: Application UUID
            tenant_id: Tenant UUID
            scan_type: Filter by scan type ('prompt' or 'response')

        Returns:
            List of enabled scanner dicts with effective settings
        """
        all_scanners = self.get_application_scanners(
            application_id,
            tenant_id,
            include_disabled=False
        )

        # Filter by scan type if specified
        if scan_type == 'prompt':
            return [s for s in all_scanners if s['scan_prompt']]
        elif scan_type == 'response':
            return [s for s in all_scanners if s['scan_response']]
        else:
            return all_scanners

    def update_scanner_config(
        self,
        application_id: UUID,
        scanner_id: UUID,
        updates: Dict[str, Any]
    ) -> ApplicationScannerConfig:
        """
        Update or create scanner config at workspace level.

        Args:
            application_id: Application UUID (resolved to workspace_id)
            scanner_id: Scanner UUID
            updates: Config updates (is_enabled, risk_level, scan_prompt, scan_response)

        Returns:
            Updated config
        """
        # Resolve to workspace level (consistent with read path)
        workspace_id = get_workspace_id_for_app(self.db, str(application_id))

        config = None
        if workspace_id:
            config = self.db.query(ApplicationScannerConfig).filter(
                ApplicationScannerConfig.workspace_id == workspace_id,
                ApplicationScannerConfig.application_id.is_(None),
                ApplicationScannerConfig.scanner_id == scanner_id
            ).first()

        if not config:
            config = ApplicationScannerConfig(
                workspace_id=workspace_id,
                scanner_id=scanner_id
            )
            self.db.add(config)

        # Update fields
        if 'is_enabled' in updates:
            config.is_enabled = updates['is_enabled']
        if 'risk_level' in updates:
            config.risk_level_override = updates['risk_level']
        if 'scan_prompt' in updates:
            config.scan_prompt_override = updates['scan_prompt']
        if 'scan_response' in updates:
            config.scan_response_override = updates['scan_response']

        self.db.commit()
        self.db.refresh(config)

        logger.info(
            f"Updated scanner config: workspace={workspace_id}, app={application_id}, "
            f"scanner={scanner_id}, updates={list(updates.keys())}"
        )

        return config

    def bulk_update_scanner_configs(
        self,
        application_id: UUID,
        updates: List[Dict[str, Any]]
    ) -> List[ApplicationScannerConfig]:
        """
        Bulk update multiple scanner configs.

        Args:
            application_id: Application UUID
            updates: List of config updates (each with scanner_id and updates)

        Returns:
            List of updated configs
        """
        results = []
        for update_item in updates:
            scanner_id = UUID(update_item['scanner_id'])
            config_updates = {
                k: v for k, v in update_item.items()
                if k != 'scanner_id'
            }
            config = self.update_scanner_config(
                application_id,
                scanner_id,
                config_updates
            )
            results.append(config)

        logger.info(
            f"Bulk updated {len(results)} scanner configs for app={application_id}"
        )

        return results

    def reset_scanner_config(
        self,
        application_id: UUID,
        scanner_id: UUID
    ) -> bool:
        """
        Reset scanner config to package defaults.

        Args:
            application_id: Application UUID (resolved to workspace_id)
            scanner_id: Scanner UUID

        Returns:
            True if reset, False if not found
        """
        workspace_id = get_workspace_id_for_app(self.db, str(application_id))

        config = None
        if workspace_id:
            config = self.db.query(ApplicationScannerConfig).filter(
                ApplicationScannerConfig.workspace_id == workspace_id,
                ApplicationScannerConfig.application_id.is_(None),
                ApplicationScannerConfig.scanner_id == scanner_id
            ).first()

        if not config:
            return False

        # Reset to defaults (NULL overrides = use package defaults)
        config.is_enabled = True
        config.risk_level_override = None
        config.scan_prompt_override = None
        config.scan_response_override = None

        self.db.commit()

        logger.info(
            f"Reset scanner config to defaults: workspace={workspace_id}, app={application_id}, scanner={scanner_id}"
        )

        return True

    def reset_all_configs(
        self,
        application_id: UUID
    ) -> int:
        """
        Reset all scanner configs to package defaults.

        Args:
            application_id: Application UUID (resolved to workspace_id)

        Returns:
            Number of configs reset
        """
        workspace_id = get_workspace_id_for_app(self.db, str(application_id))

        configs = []
        if workspace_id:
            configs = self.db.query(ApplicationScannerConfig).filter(
                ApplicationScannerConfig.workspace_id == workspace_id,
                ApplicationScannerConfig.application_id.is_(None)
            ).all()

        count = 0
        for config in configs:
            config.is_enabled = True
            config.risk_level_override = None
            config.scan_prompt_override = None
            config.scan_response_override = None
            count += 1

        self.db.commit()

        logger.info(f"Reset {count} scanner configs to defaults for app={application_id}")

        return count

    def initialize_default_configs(
        self,
        application_id: UUID = None,
        tenant_id: UUID = None,
        workspace_id: UUID = None,
    ) -> int:
        """
        Initialize default configs for all available scanners at workspace level.

        Args:
            application_id: Application UUID (resolved to workspace_id if workspace_id not provided)
            tenant_id: Tenant UUID
            workspace_id: Workspace UUID (direct, takes priority over application_id)

        Returns:
            Number of configs created
        """
        # Resolve workspace_id
        if not workspace_id and application_id:
            workspace_id = get_workspace_id_for_app(self.db, str(application_id))
        if not workspace_id:
            logger.warning(f"Cannot initialize configs: no workspace_id (app={application_id})")
            return 0

        # Get all available scanners
        available_scanners = self._get_available_scanners(tenant_id)

        count = 0
        for scanner in available_scanners:
            # Check if workspace-level config already exists
            existing = self.db.query(ApplicationScannerConfig).filter(
                ApplicationScannerConfig.workspace_id == workspace_id,
                ApplicationScannerConfig.application_id.is_(None),
                ApplicationScannerConfig.scanner_id == scanner.id
            ).first()

            if not existing:
                config = ApplicationScannerConfig(
                    workspace_id=workspace_id,
                    scanner_id=scanner.id,
                    is_enabled=True  # All enabled by default
                )
                self.db.add(config)
                count += 1

        self.db.commit()

        logger.info(
            f"Initialized {count} default scanner configs for workspace={workspace_id} (app={application_id})"
        )

        return count

    def _get_available_scanners(self, tenant_id: UUID) -> List[Scanner]:
        """
        Get scanners from basic and purchased premium packages.
        Super admins get access to all scanners (including unpurchased premium packages).

        Args:
            tenant_id: Tenant UUID

        Returns:
            List of scanners
        """
        # Check if tenant is super admin - they get access to all scanners
        tenant = self.db.query(Tenant).filter(Tenant.id == tenant_id).first()
        is_super_admin = tenant and hasattr(tenant, 'is_super_admin') and tenant.is_super_admin
        
        # Basic packages (builtin)
        builtin = self.db.query(Scanner).join(ScannerPackage).filter(
            ScannerPackage.package_type == 'basic',  # Basic packages
            ScannerPackage.is_active == True,
            Scanner.is_active == True
        ).all()

        purchased = []
        if is_super_admin:
            # Super admin gets all premium scanners
            purchased = self.db.query(Scanner).join(ScannerPackage).filter(
                ScannerPackage.package_type == 'purchasable',  # Premium packages
                ScannerPackage.is_active == True,
                Scanner.is_active == True
            ).all()
            logger.debug(f"Super admin granted access to all {len(purchased)} premium scanners")
        else:
            # Regular users only get purchased premium packages
            purchased_package_ids = [
                p[0] for p in self.db.query(PackagePurchase.package_id).filter(
                    PackagePurchase.tenant_id == tenant_id,
                    PackagePurchase.status == 'approved'
                ).all()
            ]

            if purchased_package_ids:
                purchased = self.db.query(Scanner).filter(
                    Scanner.package_id.in_(purchased_package_ids),
                    Scanner.is_active == True
                ).all()

        return builtin + purchased

    def _get_custom_scanners(self, application_id: UUID, workspace_id: Optional[str] = None) -> List[Scanner]:
        """
        Get custom scanners for workspace.

        Args:
            application_id: Application UUID (kept for backward compatibility)
            workspace_id: Workspace UUID (resolved from application_id)

        Returns:
            List of scanners with _is_custom flag
        """
        if not workspace_id:
            workspace_id = get_workspace_id_for_app(self.db, str(application_id))
        if not workspace_id:
            return []

        scanners = self.db.query(Scanner).join(CustomScanner).filter(
            CustomScanner.workspace_id == workspace_id,
            Scanner.is_active == True
        ).all()

        # Mark as custom
        for scanner in scanners:
            scanner._is_custom = True

        return scanners


# ---------------------------------------------------------------------------
# Phase 3 — async sibling class.
#
# ScannerDetectionService (the next-wave service) only needs
# `get_application_scanners`. Other ScannerConfigService methods
# (CRUD: update / reset / bulk_update / initialize_default_configs)
# are admin-side and stay sync — their callers are sync routers.
#
# Lazy loading is illegal on AsyncSession, so the async path uses
# `selectinload(Scanner.package)` to eager-load the package relationship
# that `get_application_scanners` reads via `scanner.package.package_name`.
# ---------------------------------------------------------------------------


class AsyncScannerConfigService:
    """Async variant of ScannerConfigService for the detection hot path.

    Implements only `get_application_scanners` (and its private helpers)
    — the one method ScannerDetectionService calls. Other CRUD methods
    on the sync class are not duplicated here; if a future async caller
    needs them, port one method at a time using the same pattern.
    """

    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_application_scanners(
        self,
        application_id: UUID,
        tenant_id: UUID,
        include_disabled: bool = True,
    ) -> List[Dict[str, Any]]:
        """Return all scanners for an application combined with their
        per-workspace config overrides. Same shape as the sync version."""
        workspace_id = await get_workspace_id_for_app_async(self.db, str(application_id))

        available_scanners = await self._get_available_scanners(tenant_id)
        custom_scanners = await self._get_custom_scanners(application_id, workspace_id)

        all_scanners = available_scanners + custom_scanners

        # Workspace-level config overrides.
        config_map = {}
        if workspace_id:
            res = await self.db.execute(
                select(ApplicationScannerConfig).where(
                    ApplicationScannerConfig.workspace_id == workspace_id,
                    ApplicationScannerConfig.application_id.is_(None),
                )
            )
            ws_configs = res.scalars().all()
            config_map = {str(c.scanner_id): c for c in ws_configs}

        result = []
        for scanner in all_scanners:
            config = config_map.get(str(scanner.id))

            is_enabled = config.is_enabled if config else True
            risk_level = (
                config.risk_level_override
                if config and config.risk_level_override
                else scanner.default_risk_level
            )
            scan_prompt = (
                config.scan_prompt_override
                if config and config.scan_prompt_override is not None
                else scanner.default_scan_prompt
            )
            scan_response = (
                config.scan_response_override
                if config and config.scan_response_override is not None
                else scanner.default_scan_response
            )

            if not include_disabled and not is_enabled:
                continue

            is_custom = hasattr(scanner, '_is_custom') and scanner._is_custom

            scanner_info = {
                'id': str(scanner.id),
                'tag': scanner.tag,
                'name': scanner.name,
                'description': scanner.description,
                'definition': scanner.definition,
                'scanner_type': scanner.scanner_type,
                'package_name': scanner.package.package_name if scanner.package else 'Custom',
                'package_id': str(scanner.package_id) if scanner.package_id else None,
                'package_type': scanner.package.package_type if scanner.package else 'custom',
                'is_custom': is_custom,
                'is_enabled': is_enabled,
                'risk_level': risk_level,
                'scan_prompt': scan_prompt,
                'scan_response': scan_response,
                'default_risk_level': scanner.default_risk_level,
                'default_scan_prompt': scanner.default_scan_prompt,
                'default_scan_response': scanner.default_scan_response,
                'has_risk_level_override': config and config.risk_level_override is not None if config else False,
                'has_scan_prompt_override': config and config.scan_prompt_override is not None if config else False,
                'has_scan_response_override': config and config.scan_response_override is not None if config else False,
            }
            result.append(scanner_info)

        return result

    async def _get_available_scanners(self, tenant_id: UUID) -> List[Scanner]:
        """Built-in basic scanners + (admin: all premium / regular: purchased premium).

        `package` is eager-loaded — `get_application_scanners` reads
        `scanner.package.package_name` later, and AsyncSession refuses
        to lazy-load.
        """
        # Tenant lookup (super_admin flag).
        res = await self.db.execute(select(Tenant).where(Tenant.id == tenant_id))
        tenant = res.scalar_one_or_none()
        is_super_admin = bool(tenant and getattr(tenant, 'is_super_admin', False))

        # Basic / built-in.
        res = await self.db.execute(
            select(Scanner)
            .join(ScannerPackage, Scanner.package_id == ScannerPackage.id)
            .where(
                ScannerPackage.package_type == 'basic',
                ScannerPackage.is_active == True,  # noqa: E712
                Scanner.is_active == True,  # noqa: E712
            )
            .options(selectinload(Scanner.package))
        )
        builtin = list(res.scalars().all())

        purchased: List[Scanner] = []
        if is_super_admin:
            res = await self.db.execute(
                select(Scanner)
                .join(ScannerPackage, Scanner.package_id == ScannerPackage.id)
                .where(
                    ScannerPackage.package_type == 'purchasable',
                    ScannerPackage.is_active == True,  # noqa: E712
                    Scanner.is_active == True,  # noqa: E712
                )
                .options(selectinload(Scanner.package))
            )
            purchased = list(res.scalars().all())
            logger.debug(f"Super admin granted access to all {len(purchased)} premium scanners")
        else:
            res = await self.db.execute(
                select(PackagePurchase.package_id).where(
                    PackagePurchase.tenant_id == tenant_id,
                    PackagePurchase.status == 'approved',
                )
            )
            purchased_package_ids = list(res.scalars().all())

            if purchased_package_ids:
                res = await self.db.execute(
                    select(Scanner)
                    .where(
                        Scanner.package_id.in_(purchased_package_ids),
                        Scanner.is_active == True,  # noqa: E712
                    )
                    .options(selectinload(Scanner.package))
                )
                purchased = list(res.scalars().all())

        return builtin + purchased

    async def _get_custom_scanners(
        self, application_id: UUID, workspace_id: Optional[str] = None
    ) -> List[Scanner]:
        """Workspace-scoped custom scanners. Marks each as `_is_custom = True`
        so `get_application_scanners` can render the right `package_name`."""
        if not workspace_id:
            workspace_id = await get_workspace_id_for_app_async(self.db, str(application_id))
        if not workspace_id:
            return []

        res = await self.db.execute(
            select(Scanner)
            .join(CustomScanner, Scanner.id == CustomScanner.scanner_id)
            .where(
                CustomScanner.workspace_id == workspace_id,
                Scanner.is_active == True,  # noqa: E712
            )
            .options(selectinload(Scanner.package))
        )
        scanners = list(res.scalars().all())

        for scanner in scanners:
            scanner._is_custom = True

        return scanners
