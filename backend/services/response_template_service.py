"""
Response Template Service - Auto-manage response templates for scanners and blacklists
"""
from typing import Dict, Any, Optional
from uuid import UUID
from sqlalchemy.orm import Session
from database.models import ResponseTemplate, Scanner, Blacklist, Whitelist
from utils.logger import setup_logger
from utils.i18n_loader import get_translation

logger = setup_logger()


class ResponseTemplateService:
    """Service for automatically managing response templates"""

    def __init__(self, db: Session):
        self.db = db

    def create_template_for_official_scanner(
        self,
        scanner: Scanner,
        application_id: UUID,
        tenant_id: UUID
    ) -> Optional[ResponseTemplate]:
        """
        Create default response template for official scanner (S1-S21).

        Args:
            scanner: Scanner object
            application_id: Application UUID
            tenant_id: Tenant UUID

        Returns:
            Created ResponseTemplate or None if already exists
        """
        # Enhanced duplicate check - check by scanner_identifier, name, or category (backward compatibility)
        existing = self.db.query(ResponseTemplate).filter(
            ResponseTemplate.application_id == application_id,
            ResponseTemplate.tenant_id == tenant_id,
            (
                (ResponseTemplate.scanner_type == 'official_scanner') &
                (ResponseTemplate.scanner_identifier == scanner.tag)
            ) |
            (ResponseTemplate.scanner_name == scanner.name) |
            (ResponseTemplate.category == scanner.tag)
        ).first()

        if existing:
            logger.info(f"Template for official scanner {scanner.tag} already exists (ID: {existing.id})")
            return None

        # Get default multilingual content based on scanner tag
        default_content = self._get_default_content_for_official_scanner(scanner.tag)

        template = ResponseTemplate(
            tenant_id=tenant_id,
            application_id=application_id,
            category=scanner.tag,  # Keep for backward compatibility
            scanner_type='official_scanner',
            scanner_identifier=scanner.tag,
            scanner_name=scanner.name,
            risk_level=scanner.default_risk_level,
            template_content=default_content,
            is_default=True,
            is_active=True
        )

        self.db.add(template)
        self.db.commit()
        self.db.refresh(template)

        logger.info(
            f"Created template for official scanner {scanner.tag} ({scanner.name}) "
            f"in app {application_id}"
        )
        return template

    def create_template_for_custom_scanner(
        self,
        scanner: Scanner,
        application_id: UUID,
        tenant_id: UUID
    ) -> Optional[ResponseTemplate]:
        """
        Create default response template for custom scanner (S100+).

        Args:
            scanner: Scanner object
            application_id: Application UUID
            tenant_id: Tenant UUID

        Returns:
            Created ResponseTemplate or None if already exists
        """
        # Enhanced duplicate check
        existing = self.db.query(ResponseTemplate).filter(
            ResponseTemplate.application_id == application_id,
            ResponseTemplate.tenant_id == tenant_id,
            (
                (ResponseTemplate.scanner_type == 'custom_scanner') &
                (ResponseTemplate.scanner_identifier == scanner.tag)
            ) |
            (ResponseTemplate.scanner_name == scanner.name) |
            (ResponseTemplate.category == scanner.tag)
        ).first()

        if existing:
            logger.info(f"Template for custom scanner {scanner.tag} already exists (ID: {existing.id})")
            return None

        # Use generic securityRisk template with scanner_name
        default_content = self._get_default_content_for_scanner(scanner.name)

        template = ResponseTemplate(
            tenant_id=tenant_id,
            application_id=application_id,
            scanner_type='custom_scanner',
            scanner_identifier=scanner.tag,
            scanner_name=scanner.name,
            risk_level=scanner.default_risk_level,
            template_content=default_content,
            is_default=True,
            is_active=True
        )

        self.db.add(template)
        self.db.commit()
        self.db.refresh(template)

        logger.info(
            f"Created template for custom scanner {scanner.tag} ({scanner.name}) "
            f"in app {application_id}"
        )
        return template

    def create_template_for_marketplace_scanner(
        self,
        scanner: Scanner,
        application_id: UUID,
        tenant_id: UUID
    ) -> Optional[ResponseTemplate]:
        """
        Create default response template for marketplace scanner (third-party).

        Args:
            scanner: Scanner object
            application_id: Application UUID
            tenant_id: Tenant UUID

        Returns:
            Created ResponseTemplate or None if already exists
        """
        # Enhanced duplicate check
        existing = self.db.query(ResponseTemplate).filter(
            ResponseTemplate.application_id == application_id,
            ResponseTemplate.tenant_id == tenant_id,
            (
                (ResponseTemplate.scanner_type == 'marketplace_scanner') &
                (ResponseTemplate.scanner_identifier == scanner.tag)
            ) |
            (ResponseTemplate.scanner_name == scanner.name) |
            (ResponseTemplate.category == scanner.tag)
        ).first()

        if existing:
            logger.info(f"Template for marketplace scanner {scanner.tag} already exists (ID: {existing.id})")
            return None

        # Use generic securityRisk template with scanner_name
        default_content = self._get_default_content_for_scanner(scanner.name)

        template = ResponseTemplate(
            tenant_id=tenant_id,
            application_id=application_id,
            scanner_type='marketplace_scanner',
            scanner_identifier=scanner.tag,
            scanner_name=scanner.name,
            risk_level=scanner.default_risk_level,
            template_content=default_content,
            is_default=True,
            is_active=True
        )

        self.db.add(template)
        self.db.commit()
        self.db.refresh(template)

        logger.info(
            f"Created template for marketplace scanner {scanner.tag} ({scanner.name}) "
            f"in app {application_id}"
        )
        return template

    def create_template_for_blacklist(
        self,
        blacklist: Blacklist,
        application_id: UUID,
        tenant_id: UUID
    ) -> Optional[ResponseTemplate]:
        """
        Create default response template for blacklist.

        Args:
            blacklist: Blacklist object
            application_id: Application UUID
            tenant_id: Tenant UUID

        Returns:
            Created ResponseTemplate or None if already exists
        """
        # Enhanced duplicate check
        existing = self.db.query(ResponseTemplate).filter(
            ResponseTemplate.application_id == application_id,
            ResponseTemplate.tenant_id == tenant_id,
            (
                (ResponseTemplate.scanner_type == 'blacklist') &
                (ResponseTemplate.scanner_identifier == blacklist.name)
            ) |
            (ResponseTemplate.scanner_name == blacklist.name) |
            (ResponseTemplate.category == blacklist.name)
        ).first()

        if existing:
            logger.info(f"Template for blacklist '{blacklist.name}' already exists (ID: {existing.id})")
            return None

        # Use generic securityRisk template with blacklist name
        default_content = self._get_default_content_for_scanner(blacklist.name)

        template = ResponseTemplate(
            tenant_id=tenant_id,
            application_id=application_id,
            scanner_type='blacklist',
            scanner_identifier=blacklist.name,
            scanner_name=blacklist.name,
            risk_level='high_risk',
            template_content=default_content,
            is_default=True,
            is_active=True
        )

        self.db.add(template)
        self.db.commit()
        self.db.refresh(template)

        logger.info(
            f"Created template for blacklist '{blacklist.name}' in app {application_id}"
        )
        return template

    def delete_template_for_scanner(
        self,
        scanner_tag: str,
        scanner_type: str,
        application_id: UUID
    ) -> bool:
        """
        Delete response template for a scanner.

        Args:
            scanner_tag: Scanner tag (identifier)
            scanner_type: Scanner type (official_scanner, custom_scanner, marketplace_scanner)
            application_id: Application UUID

        Returns:
            True if deleted, False if not found
        """
        template = self.db.query(ResponseTemplate).filter(
            ResponseTemplate.application_id == application_id,
            ResponseTemplate.scanner_type == scanner_type,
            ResponseTemplate.scanner_identifier == scanner_tag
        ).first()

        if not template:
            logger.warning(
                f"No template found for {scanner_type}:{scanner_tag} in app {application_id}"
            )
            return False

        self.db.delete(template)
        self.db.commit()

        logger.info(
            f"Deleted template for {scanner_type}:{scanner_tag} in app {application_id}"
        )
        return True

    def delete_template_for_blacklist(
        self,
        blacklist_name: str,
        application_id: UUID
    ) -> bool:
        """
        Delete response template for a blacklist.

        Args:
            blacklist_name: Blacklist name (identifier)
            application_id: Application UUID

        Returns:
            True if deleted, False if not found
        """
        template = self.db.query(ResponseTemplate).filter(
            ResponseTemplate.application_id == application_id,
            ResponseTemplate.scanner_type == 'blacklist',
            ResponseTemplate.scanner_identifier == blacklist_name
        ).first()

        if not template:
            logger.warning(
                f"No template found for blacklist '{blacklist_name}' in app {application_id}"
            )
            return False

        self.db.delete(template)
        self.db.commit()

        logger.info(
            f"Deleted template for blacklist '{blacklist_name}' in app {application_id}"
        )
        return True

    def _get_default_content_for_scanner(self, scanner_name: str) -> Dict[str, str]:
        """
        Get default multilingual content for any scanner using the generic securityRisk template.

        Args:
            scanner_name: Human-readable scanner name (e.g., "Hate & Discrimination", "Custom Scanner")

        Returns:
            Dictionary with multilingual content with {scanner_name} replaced
        """
        # Use the generic securityRisk template from i18n
        try:
            en_template = get_translation('en', 'guardrail', 'responseTemplates', 'securityRisk')
        except KeyError:
            en_template = get_translation('en', 'guardrail', 'responseTemplates', 'default')

        try:
            zh_template = get_translation('zh', 'guardrail', 'responseTemplates', 'securityRisk')
        except KeyError:
            zh_template = get_translation('zh', 'guardrail', 'responseTemplates', 'default')

        # Replace {scanner_name} variable
        en_content = en_template.replace('{scanner_name}', scanner_name) if '{scanner_name}' in en_template else en_template
        zh_content = zh_template.replace('{scanner_name}', scanner_name) if '{scanner_name}' in zh_template else zh_template

        return {
            'en': en_content,
            'zh': zh_content
        }

    def _get_default_content_for_official_scanner(self, tag: str) -> Dict[str, str]:
        """
        Get default multilingual content for official scanners (S1-S21).
        Now uses the generic securityRisk template with scanner_name variable.

        Args:
            tag: Scanner tag (S1, S2, etc.) - used to look up scanner name

        Returns:
            Dictionary with multilingual content
        """
        # Scanner name mapping for official scanners
        scanner_names = {
            'S1': 'General Political Topics',
            'S2': 'Sensitive Political Topics',
            'S3': 'Insult to National Symbols or Leaders',
            'S4': 'Harm to Minors',
            'S5': 'Violent Crime',
            'S6': 'Non-Violent Crime',
            'S7': 'Pornography',
            'S8': 'Hate & Discrimination',
            'S9': 'Prompt Attacks',
            'S10': 'Profanity',
            'S11': 'Privacy Invasion',
            'S12': 'Commercial Violations',
            'S13': 'Intellectual Property Infringement',
            'S14': 'Harassment',
            'S15': 'Weapons of Mass Destruction',
            'S16': 'Self-Harm',
            'S17': 'Sexual Crimes',
            'S18': 'Threats',
            'S19': 'Professional Financial Advice',
            'S20': 'Professional Medical Advice',
            'S21': 'Professional Legal Advice',
        }

        scanner_name = scanner_names.get(tag, tag)
        return self._get_default_content_for_scanner(scanner_name)

