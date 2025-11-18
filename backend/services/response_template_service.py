"""
Response Template Service - Auto-manage response templates for scanners and blacklists
"""
from typing import Dict, Any, Optional
from uuid import UUID
from sqlalchemy.orm import Session
from database.models import ResponseTemplate, Scanner, Blacklist, Whitelist
from utils.logger import setup_logger

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
        # Check if template already exists
        existing = self.db.query(ResponseTemplate).filter(
            ResponseTemplate.application_id == application_id,
            ResponseTemplate.scanner_type == 'official_scanner',
            ResponseTemplate.scanner_identifier == scanner.tag
        ).first()

        if existing:
            logger.info(f"Template for official scanner {scanner.tag} already exists")
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
        # Check if template already exists
        existing = self.db.query(ResponseTemplate).filter(
            ResponseTemplate.application_id == application_id,
            ResponseTemplate.scanner_type == 'custom_scanner',
            ResponseTemplate.scanner_identifier == scanner.tag
        ).first()

        if existing:
            logger.info(f"Template for custom scanner {scanner.tag} already exists")
            return None

        default_content = {
            "en": f"This content is not allowed. Reason: {scanner.name}",
            "zh": f"此内容不被允许。原因：{scanner.name}"
        }

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
        # Check if template already exists
        existing = self.db.query(ResponseTemplate).filter(
            ResponseTemplate.application_id == application_id,
            ResponseTemplate.scanner_type == 'marketplace_scanner',
            ResponseTemplate.scanner_identifier == scanner.tag
        ).first()

        if existing:
            logger.info(f"Template for marketplace scanner {scanner.tag} already exists")
            return None

        default_content = {
            "en": f"This content is not allowed. Detected by: {scanner.name}",
            "zh": f"此内容不被允许。检测到：{scanner.name}"
        }

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
        # Check if template already exists
        existing = self.db.query(ResponseTemplate).filter(
            ResponseTemplate.application_id == application_id,
            ResponseTemplate.scanner_type == 'blacklist',
            ResponseTemplate.scanner_identifier == blacklist.name
        ).first()

        if existing:
            logger.info(f"Template for blacklist '{blacklist.name}' already exists")
            return None

        default_content = {
            "en": f"This content violates our policy. (Blacklist: {blacklist.name})",
            "zh": f"此内容违反了我们的政策。（黑名单：{blacklist.name}）"
        }

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

    def _get_default_content_for_official_scanner(self, tag: str) -> Dict[str, str]:
        """
        Get default multilingual content for official scanners (S1-S21).

        Args:
            tag: Scanner tag (S1, S2, etc.)

        Returns:
            Dictionary with multilingual content
        """
        # Default content mapping for S1-S21
        default_contents = {
            'S1': {
                'en': 'Your message contains general political content that may not be appropriate.',
                'zh': '您的消息包含一般性政治内容，可能不合适。'
            },
            'S2': {
                'en': 'Your message contains sensitive political topics that are not allowed.',
                'zh': '您的消息包含敏感的政治话题，不被允许。'
            },
            'S3': {
                'en': 'Your message contains insults to national symbols or leaders, which is prohibited.',
                'zh': '您的消息包含对国家象征或领导人的侮辱，这是被禁止的。'
            },
            'S4': {
                'en': 'Your message contains content that may harm minors, which is strictly prohibited.',
                'zh': '您的消息包含可能伤害未成年人的内容，这是严格禁止的。'
            },
            'S5': {
                'en': 'Your message contains violent crime content, which is not allowed.',
                'zh': '您的消息包含暴力犯罪内容，不被允许。'
            },
            'S6': {
                'en': 'Your message contains non-violent crime content, which is not allowed.',
                'zh': '您的消息包含非暴力犯罪内容，不被允许。'
            },
            'S7': {
                'en': 'Your message contains pornographic content, which is strictly prohibited.',
                'zh': '您的消息包含色情内容，这是严格禁止的。'
            },
            'S8': {
                'en': 'Your message contains hate speech or discrimination, which is not allowed.',
                'zh': '您的消息包含仇恨言论或歧视，不被允许。'
            },
            'S9': {
                'en': 'Your message appears to be a prompt injection attack, which is prohibited.',
                'zh': '您的消息似乎是提示词注入攻击，这是被禁止的。'
            },
            'S10': {
                'en': 'Your message contains gambling-related content, which is not allowed.',
                'zh': '您的消息包含赌博相关内容，不被允许。'
            },
            'S11': {
                'en': 'Your message contains drug-related content, which is not allowed.',
                'zh': '您的消息包含毒品相关内容，不被允许。'
            },
            'S12': {
                'en': 'Your message contains self-harm content, which is concerning and not allowed.',
                'zh': '您的消息包含自残内容，这令人担忧且不被允许。'
            },
            'S13': {
                'en': 'Your message contains fraudulent schemes, which are strictly prohibited.',
                'zh': '您的消息包含欺诈计划，这是严格禁止的。'
            },
            'S14': {
                'en': 'Your message contains illegal activities, which are not allowed.',
                'zh': '您的消息包含非法活动，不被允许。'
            },
            'S15': {
                'en': 'Your message contains malicious code or security threats, which are prohibited.',
                'zh': '您的消息包含恶意代码或安全威胁，这是被禁止的。'
            },
            'S16': {
                'en': 'Your message may infringe intellectual property rights, which is not allowed.',
                'zh': '您的消息可能侵犯知识产权，不被允许。'
            },
            'S17': {
                'en': 'Your message contains misinformation, which we cannot support.',
                'zh': '您的消息包含虚假信息，我们无法支持。'
            },
            'S18': {
                'en': 'Your message involves privacy violations, which are strictly prohibited.',
                'zh': '您的消息涉及隐私侵犯，这是严格禁止的。'
            },
            'S19': {
                'en': 'Your message contains spam or advertising, which is not allowed.',
                'zh': '您的消息包含垃圾信息或广告，不被允许。'
            },
            'S20': {
                'en': 'Your message contains unsafe advice that could cause harm.',
                'zh': '您的消息包含可能造成伤害的不安全建议。'
            },
            'S21': {
                'en': 'Your message contains specialized knowledge that requires verification.',
                'zh': '您的消息包含需要验证的专业知识。'
            }
        }

        # Return specific content or default generic content
        return default_contents.get(tag, {
            'en': 'Your message contains content that is not allowed.',
            'zh': '您的消息包含不被允许的内容。'
        })

