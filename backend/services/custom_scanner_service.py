"""
Custom Scanner Service
Handles user-defined custom scanners (S100+)
"""

from typing import List, Optional, Dict, Any
from uuid import UUID
from sqlalchemy.orm import Session
from sqlalchemy import func, and_, Integer

from database.models import (
    Scanner, CustomScanner, ApplicationScannerConfig,
    TenantSubscription
)
from utils.logger import setup_logger
from services.response_template_service import ResponseTemplateService
from services.workspace_resolver import get_workspace_id_for_app

logger = setup_logger()




class CustomScannerService:
    """Service for managing custom scanners"""

    def __init__(self, db: Session):
        self.db = db

    def get_custom_scanners(
        self,
        application_id: UUID,
        workspace_id: str = None
    ) -> List[Dict[str, Any]]:
        """
        Get all custom scanners for workspace.

        Args:
            application_id: Application UUID (used to resolve workspace if workspace_id not provided)
            workspace_id: Workspace UUID (preferred)

        Returns:
            List of custom scanner dicts
        """
        # Resolve workspace_id
        if not workspace_id:
            workspace_id = get_workspace_id_for_app(self.db, str(application_id))

        if workspace_id:
            custom_scanners = self.db.query(CustomScanner).join(Scanner).filter(
                CustomScanner.workspace_id == workspace_id,
                Scanner.is_active == True
            ).all()
        else:
            # Fallback to application_id for backward compatibility
            custom_scanners = self.db.query(CustomScanner).join(Scanner).filter(
                CustomScanner.application_id == application_id,
                Scanner.is_active == True
            ).all()

        result = []
        for cs in custom_scanners:
            scanner = cs.scanner
            ws_id = workspace_id or str(cs.workspace_id) if cs.workspace_id else None

            # Get scanner config for is_enabled status (workspace-level first, then app-level fallback)
            config = None
            if ws_id:
                config = self.db.query(ApplicationScannerConfig).filter(
                    ApplicationScannerConfig.workspace_id == ws_id,
                    ApplicationScannerConfig.application_id.is_(None),
                    ApplicationScannerConfig.scanner_id == scanner.id
                ).first()
            if not config:
                config = self.db.query(ApplicationScannerConfig).filter(
                    ApplicationScannerConfig.application_id == application_id,
                    ApplicationScannerConfig.scanner_id == scanner.id
                ).first()

            result.append({
                'id': str(scanner.id),
                'custom_scanner_id': str(cs.id),
                'tag': scanner.tag,
                'name': scanner.name,
                'description': scanner.description,
                'scanner_type': scanner.scanner_type,
                'definition': scanner.definition,
                'default_risk_level': scanner.default_risk_level,
                'default_scan_prompt': scanner.default_scan_prompt,
                'default_scan_response': scanner.default_scan_response,
                'notes': cs.notes,
                'created_by': str(cs.created_by),
                'created_at': cs.created_at.isoformat() if cs.created_at else None,
                'updated_at': cs.updated_at.isoformat() if cs.updated_at else None,
                'is_enabled': config.is_enabled if config else True
            })

        return result

    def get_custom_scanner(
        self,
        scanner_id: UUID,
        application_id: UUID,
        workspace_id: str = None
    ) -> Optional[Dict[str, Any]]:
        """
        Get custom scanner details.

        Args:
            scanner_id: Scanner UUID
            application_id: Application UUID
            workspace_id: Workspace UUID

        Returns:
            Scanner dict or None
        """
        if not workspace_id:
            workspace_id = get_workspace_id_for_app(self.db, str(application_id))

        # Try workspace-level first
        cs = None
        if workspace_id:
            cs = self.db.query(CustomScanner).join(Scanner).filter(
                CustomScanner.workspace_id == workspace_id,
                Scanner.id == scanner_id,
                Scanner.is_active == True
            ).first()

        # Fallback to app-level
        if not cs:
            cs = self.db.query(CustomScanner).join(Scanner).filter(
                CustomScanner.application_id == application_id,
                Scanner.id == scanner_id,
                Scanner.is_active == True
            ).first()

        if not cs:
            return None

        scanner = cs.scanner
        ws_id = workspace_id or (str(cs.workspace_id) if cs.workspace_id else None)

        # Get scanner config for is_enabled status (workspace-level first)
        config = None
        if ws_id:
            config = self.db.query(ApplicationScannerConfig).filter(
                ApplicationScannerConfig.workspace_id == ws_id,
                ApplicationScannerConfig.application_id.is_(None),
                ApplicationScannerConfig.scanner_id == scanner.id
            ).first()
        if not config:
            config = self.db.query(ApplicationScannerConfig).filter(
                ApplicationScannerConfig.application_id == application_id,
                ApplicationScannerConfig.scanner_id == scanner.id
            ).first()

        return {
            'id': str(scanner.id),
            'custom_scanner_id': str(cs.id),
            'tag': scanner.tag,
            'name': scanner.name,
            'description': scanner.description,
            'scanner_type': scanner.scanner_type,
            'definition': scanner.definition,
            'default_risk_level': scanner.default_risk_level,
            'default_scan_prompt': scanner.default_scan_prompt,
            'default_scan_response': scanner.default_scan_response,
            'notes': cs.notes,
            'created_by': str(cs.created_by),
            'created_at': cs.created_at.isoformat() if cs.created_at else None,
            'updated_at': cs.updated_at.isoformat() if cs.updated_at else None,
            'is_enabled': config.is_enabled if config else True
        }

    def create_custom_scanner(
        self,
        application_id: UUID,
        tenant_id: UUID,
        scanner_data: Dict[str, Any],
        workspace_id: str = None
    ) -> Dict[str, Any]:
        """
        Create a new custom scanner with auto-assigned S100+ tag.

        Args:
            application_id: Application UUID
            tenant_id: Tenant UUID (creator)
            scanner_data: Scanner data dict
            workspace_id: Workspace UUID (resolved from application if not provided)

        Returns:
            Created scanner dict

        Raises:
            ValueError: If validation fails
        """
        # Validate scanner data
        self._validate_scanner_data(scanner_data)

        # Resolve workspace_id
        if not workspace_id:
            workspace_id = get_workspace_id_for_app(self.db, str(application_id))

        # Auto-assign tag (S100+)
        tag = self._get_next_custom_tag(application_id)

        # Create scanner
        scanner = Scanner(
            package_id=None,  # Custom scanners don't belong to packages
            tag=tag,
            name=scanner_data['name'],
            description=scanner_data.get('description', scanner_data['definition']),
            scanner_type=scanner_data['scanner_type'],
            definition=scanner_data['definition'],
            default_risk_level=scanner_data['risk_level'],
            default_scan_prompt=scanner_data.get('scan_prompt', True),
            default_scan_response=scanner_data.get('scan_response', True),
            is_active=True
        )
        self.db.add(scanner)
        self.db.flush()

        # Create custom scanner record (workspace-level)
        import uuid as uuid_mod
        custom_scanner = CustomScanner(
            application_id=application_id,
            workspace_id=uuid_mod.UUID(workspace_id) if workspace_id else None,
            scanner_id=scanner.id,
            created_by=tenant_id,
            notes=scanner_data.get('notes')
        )
        self.db.add(custom_scanner)

        # Create default config at workspace level (enabled)
        config = ApplicationScannerConfig(
            workspace_id=workspace_id,
            scanner_id=scanner.id,
            is_enabled=True
        )
        self.db.add(config)

        self.db.commit()
        self.db.refresh(scanner)
        self.db.refresh(custom_scanner)

        logger.info(
            f"Created custom scanner: {scanner.tag} ({scanner.name}) "
            f"for app={application_id}, type={scanner.scanner_type}"
        )

        # Auto-create response template for this custom scanner
        try:
            template_service = ResponseTemplateService(self.db)
            template_service.create_template_for_custom_scanner(
                scanner=scanner,
                application_id=application_id,
                tenant_id=tenant_id
            )
        except Exception as e:
            logger.error(f"Failed to create response template for custom scanner {scanner.tag}: {e}")

        return {
            'id': str(scanner.id),
            'custom_scanner_id': str(custom_scanner.id),
            'tag': scanner.tag,
            'name': scanner.name,
            'description': scanner.description,
            'scanner_type': scanner.scanner_type,
            'definition': scanner.definition,
            'default_risk_level': scanner.default_risk_level,
            'default_scan_prompt': scanner.default_scan_prompt,
            'default_scan_response': scanner.default_scan_response,
            'notes': custom_scanner.notes,
            'created_by': str(custom_scanner.created_by),
            'created_at': custom_scanner.created_at.isoformat() if custom_scanner.created_at else None,
            'updated_at': custom_scanner.updated_at.isoformat() if custom_scanner.updated_at else None,
            'is_enabled': True
        }

    def update_custom_scanner(
        self,
        scanner_id: UUID,
        application_id: UUID,
        updates: Dict[str, Any],
        workspace_id: str = None
    ) -> Optional[Dict[str, Any]]:
        """
        Update custom scanner.

        Args:
            scanner_id: Scanner UUID
            application_id: Application UUID
            updates: Fields to update
            workspace_id: Workspace UUID

        Returns:
            Updated scanner dict or None
        """
        if not workspace_id:
            workspace_id = get_workspace_id_for_app(self.db, str(application_id))

        # Verify this is a custom scanner for this workspace
        cs = None
        if workspace_id:
            cs = self.db.query(CustomScanner).filter(
                CustomScanner.workspace_id == workspace_id,
                CustomScanner.scanner_id == scanner_id
            ).first()
        # Fallback to app-level
        if not cs:
            cs = self.db.query(CustomScanner).filter(
                CustomScanner.application_id == application_id,
                CustomScanner.scanner_id == scanner_id
            ).first()

        if not cs:
            return None

        scanner = cs.scanner

        # Update scanner fields
        allowed_fields = [
            'name', 'description', 'definition',
            'default_risk_level', 'default_scan_prompt', 'default_scan_response'
        ]

        for field in allowed_fields:
            if field in updates:
                setattr(scanner, field, updates[field])

        # Update notes
        if 'notes' in updates:
            cs.notes = updates['notes']

        # Update is_enabled in ApplicationScannerConfig
        if 'is_enabled' in updates:
            # Try workspace-level config first
            config = None
            if workspace_id:
                config = self.db.query(ApplicationScannerConfig).filter(
                    ApplicationScannerConfig.workspace_id == workspace_id,
                    ApplicationScannerConfig.application_id.is_(None),
                    ApplicationScannerConfig.scanner_id == scanner_id
                ).first()
            if not config:
                config = self.db.query(ApplicationScannerConfig).filter(
                    ApplicationScannerConfig.application_id == application_id,
                    ApplicationScannerConfig.scanner_id == scanner_id
                ).first()

            if config:
                config.is_enabled = updates['is_enabled']
            else:
                # Create config at workspace level
                config = ApplicationScannerConfig(
                    workspace_id=workspace_id,
                    scanner_id=scanner_id,
                    is_enabled=updates['is_enabled']
                )
                self.db.add(config)

        self.db.commit()
        self.db.refresh(scanner)
        self.db.refresh(cs)

        logger.info(
            f"Updated custom scanner: {scanner.tag} ({scanner.name}), "
            f"fields={list(updates.keys())}"
        )

        return self.get_custom_scanner(scanner_id, application_id, workspace_id)

    def delete_custom_scanner(
        self,
        scanner_id: UUID,
        application_id: UUID,
        workspace_id: str = None
    ) -> bool:
        """
        Delete custom scanner.

        Note: This will cascade delete configs.

        Args:
            scanner_id: Scanner UUID
            application_id: Application UUID
            workspace_id: Workspace UUID

        Returns:
            True if deleted, False if not found
        """
        if not workspace_id:
            workspace_id = get_workspace_id_for_app(self.db, str(application_id))

        # Verify this is a custom scanner for this workspace
        cs = None
        if workspace_id:
            cs = self.db.query(CustomScanner).filter(
                CustomScanner.workspace_id == workspace_id,
                CustomScanner.scanner_id == scanner_id
            ).first()
        # Fallback to app-level
        if not cs:
            cs = self.db.query(CustomScanner).filter(
                CustomScanner.application_id == application_id,
                CustomScanner.scanner_id == scanner_id
            ).first()

        if not cs:
            return False

        scanner = cs.scanner
        tag = scanner.tag
        name = scanner.name

        # Auto-delete response template for this custom scanner
        try:
            template_service = ResponseTemplateService(self.db)
            template_service.delete_template_for_scanner(
                scanner_tag=tag,
                scanner_type='custom_scanner',
                application_id=application_id
            )
        except Exception as e:
            logger.error(f"Failed to delete response template for custom scanner {tag}: {e}")

        # Delete knowledge bases associated with this custom scanner
        try:
            from database.models import KnowledgeBase
            deleted_kbs = self.db.query(KnowledgeBase).filter(
                KnowledgeBase.application_id == application_id,
                KnowledgeBase.scanner_type == 'custom_scanner',
                KnowledgeBase.scanner_identifier == tag
            ).delete(synchronize_session=False)
            if deleted_kbs > 0:
                logger.info(f"Deleted {deleted_kbs} knowledge base(s) associated with custom scanner {tag}")
        except Exception as e:
            logger.error(f"Failed to delete knowledge bases for custom scanner {tag}: {e}")

        # Clean up application scanner configs first
        deleted_configs = self.db.query(ApplicationScannerConfig).filter(
            ApplicationScannerConfig.scanner_id == scanner_id
        ).delete(synchronize_session=False)

        # Soft delete by marking as inactive and modifying tag to avoid unique constraint
        # This allows the same tag to be reused for new scanners
        import time
        deleted_tag = f"{tag}_deleted_{int(time.time())}"
        scanner.tag = deleted_tag
        scanner.is_active = False
        self.db.commit()

        logger.warning(
            f"Deleted custom scanner: {tag} ({name}) from app={application_id}, "
            f"renamed tag to {deleted_tag}, removed {deleted_configs} config records"
        )

        return True

    
    def _validate_scanner_data(self, scanner_data: Dict[str, Any]):
        """
        Validate scanner data.

        Raises:
            ValueError: If validation fails
        """
        required_fields = ['name', 'scanner_type', 'definition', 'risk_level']
        for field in required_fields:
            if field not in scanner_data:
                raise ValueError(f"Missing required field: {field}")

        # Validate scanner type
        valid_types = ['genai', 'regex', 'keyword']
        if scanner_data['scanner_type'] not in valid_types:
            raise ValueError(
                f"Invalid scanner_type: {scanner_data['scanner_type']}. "
                f"Must be one of: {', '.join(valid_types)}"
            )

        # Validate risk level
        valid_levels = ['high_risk', 'medium_risk', 'low_risk']
        if scanner_data['risk_level'] not in valid_levels:
            raise ValueError(
                f"Invalid risk_level: {scanner_data['risk_level']}. "
                f"Must be one of: {', '.join(valid_levels)}"
            )

        # Validate definition length
        if len(scanner_data['definition']) > 2000:
            raise ValueError("Definition too long (max 2000 characters)")

        # Validate name length
        if len(scanner_data['name']) > 200:
            raise ValueError("Name too long (max 200 characters)")

    def _get_next_custom_tag(self, application_id: UUID) -> str:
        """
        Get next available custom scanner tag (S100+).

        Args:
            application_id: Application UUID

        Returns:
            Next tag (e.g., 'S100', 'S101', ...)
        """
        # Query highest tag number globally (Scanner.tag has unique constraint)
        # Only consider S-prefixed tags for numeric parsing
        result = self.db.query(
            func.max(
                func.cast(
                    func.substr(Scanner.tag, 2),  # Remove 'S' prefix
                    Integer
                )
            )
        ).filter(
            Scanner.tag.like('S%'),
            Scanner.tag.op('~')('^[S][0-9]+$'),  # Ensure S followed by digits only using regex operator
            Scanner.is_active == True
        ).scalar()

        # Start from S100 if no custom tags exist, or use next number
        if result is None or result < 100:
            return 'S100'
        else:
            return f'S{result + 1}'
