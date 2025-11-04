"""
Data security service - sensitive data detection and de-sensitization based on regular expressions
"""
import re
import hashlib
import random
import string
import logging
from typing import List, Dict, Any, Optional, Tuple
from sqlalchemy.orm import Session
from sqlalchemy import and_
from datetime import datetime
from database.models import DataSecurityEntityType, TenantEntityTypeDisable
from utils.logger import setup_logger

logger = setup_logger()

# Risk level mapping
RISK_LEVEL_MAPPING = {
    'low': 'low_risk',
    'medium': 'medium_risk',
    'high': 'high_risk'
}

class DataSecurityService:
    """Data security service - sensitive data detection and de-sensitization"""

    def __init__(self, db: Session):
        self.db = db

    async def detect_sensitive_data(
        self,
        text: str,
        tenant_id: str,  # tenant_id, for backward compatibility keep parameter name tenant_id
        direction: str = "input"  # input or output
    ) -> Dict[str, Any]:
        """
        Detect sensitive data in text

        Args:
            text: text to detect
            tenant_id: tenant ID (actually tenant_id, parameter name for backward compatibility)
            direction: detection direction, input means input detection, output means output detection

        Returns:
            Detection result, including risk level, detected categories and de-sensitized text
        """
        # Get tenant's sensitive data definition
        entity_types = self._get_user_entity_types(tenant_id, direction)

        if not entity_types:
            return {
                'risk_level': 'no_risk',
                'categories': [],
                'detected_entities': [],
                'anonymized_text': text
            }

        # Detect sensitive data
        detected_entities = []
        highest_risk_level = 'no_risk'
        detected_categories = set()

        for entity_type in entity_types:
            matches = self._match_pattern(text, entity_type)
            if matches:
                detected_entities.extend(matches)
                detected_categories.add(entity_type['entity_type'])

                # Update highest risk level
                entity_risk = entity_type.get('risk_level', 'medium')
                if self._compare_risk_level(entity_risk, highest_risk_level) > 0:
                    highest_risk_level = RISK_LEVEL_MAPPING.get(entity_risk, 'medium_risk')

        # De-sensitization
        anonymized_text = self._anonymize_text(text, detected_entities, entity_types)

        return {
            'risk_level': highest_risk_level,
            'categories': list(detected_categories),
            'detected_entities': detected_entities,
            'anonymized_text': anonymized_text
        }

    def _get_user_entity_types(self, tenant_id: str, direction: str) -> List[Dict[str, Any]]:
        """Get tenant's sensitive data type configuration

        Note: For backward compatibility, keep function name _get_user_entity_types, parameter name tenant_id, but actually process tenant_id
        """
        tenant_id = tenant_id  # For backward compatibility, internally use tenant_id
        try:
            # Ensure tenant has copies of all system templates
            self.ensure_tenant_has_system_copies(tenant_id)
            
            # Get disabled entity types for this tenant
            disabled_entity_types = set()
            disabled_query = self.db.query(TenantEntityTypeDisable).filter(
                TenantEntityTypeDisable.tenant_id == tenant_id
            )
            for disabled in disabled_query.all():
                disabled_entity_types.add(disabled.entity_type)

            # Get only tenant's own entity types (both system_copy and custom)
            # No longer include global templates directly
            query = self.db.query(DataSecurityEntityType).filter(
                and_(
                    DataSecurityEntityType.is_active == True,
                    DataSecurityEntityType.tenant_id == tenant_id
                )
            )

            entity_types_orm = query.all()
            logger.info(f"Found {len(entity_types_orm)} entity types for tenant {tenant_id}")
            entity_types = []

            for et in entity_types_orm:
                # Skip if this entity type is disabled by the tenant
                if et.entity_type in disabled_entity_types:
                    continue

                # Check if the corresponding direction detection is enabled
                recognition_config = et.recognition_config or {}
                if direction == "input" and not recognition_config.get('check_input', True):
                    continue
                if direction == "output" and not recognition_config.get('check_output', True):
                    continue

                entity_types.append({
                    'entity_type': et.entity_type,
                    'display_name': et.display_name,
                    'risk_level': et.category,  # Use category field to store risk level
                    'pattern': recognition_config.get('pattern', ''),
                    'anonymization_method': et.anonymization_method,
                    'anonymization_config': et.anonymization_config or {}
                })

            return entity_types
        except Exception as e:
            logger.error(f"Error getting entity types: {e}")
            return []

    def _match_pattern(self, text: str, entity_type: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Use regular expression to match sensitive data"""
        matches = []
        pattern = entity_type.get('pattern', '')

        if not pattern:
            return matches

        try:
            regex = re.compile(pattern)
            for match in regex.finditer(text):
                matches.append({
                    'entity_type': entity_type['entity_type'],
                    'display_name': entity_type['display_name'],
                    'start': match.start(),
                    'end': match.end(),
                    'text': match.group(),
                    'risk_level': entity_type['risk_level'],
                    'anonymization_method': entity_type['anonymization_method'],
                    'anonymization_config': entity_type['anonymization_config']
                })
        except re.error as e:
            logger.error(f"Invalid regex pattern for {entity_type['entity_type']}: {e}")

        return matches

    def _anonymize_text(
        self,
        text: str,
        detected_entities: List[Dict[str, Any]],
        entity_types: List[Dict[str, Any]]
    ) -> str:
        """De-sensitize text"""
        if not detected_entities:
            return text

        # Sort by position in descending order, replace from back to front to avoid position offset
        sorted_entities = sorted(detected_entities, key=lambda x: x['start'], reverse=True)

        anonymized_text = text
        for entity in sorted_entities:
            method = entity.get('anonymization_method', 'replace')
            config = entity.get('anonymization_config', {})
            original_text = entity['text']

            # Process according to de-sensitization method
            if method == 'replace':
                # Replace with placeholder
                replacement = config.get('replacement', f"<{entity['entity_type']}>")
            elif method == 'mask':
                # Mask
                mask_char = config.get('mask_char', '*')
                keep_prefix = config.get('keep_prefix', 0)
                keep_suffix = config.get('keep_suffix', 0)
                replacement = self._mask_string(original_text, mask_char, keep_prefix, keep_suffix)
            elif method == 'hash':
                # Hash
                replacement = self._hash_string(original_text)
            elif method == 'encrypt':
                # Encrypt (simplified implementation, actually should use real encryption)
                replacement = f"<ENCRYPTED_{hashlib.md5(original_text.encode()).hexdigest()[:8]}>"
            elif method == 'shuffle':
                # Shuffle
                replacement = self._shuffle_string(original_text)
            elif method == 'random':
                # Random replace
                replacement = self._random_replacement(original_text)
            else:
                # Default replace
                replacement = f"<{entity['entity_type']}>"

            # Replace text
            anonymized_text = anonymized_text[:entity['start']] + replacement + anonymized_text[entity['end']:]

        return anonymized_text

    def _mask_string(self, text: str, mask_char: str = '*', keep_prefix: int = 0, keep_suffix: int = 0) -> str:
        """Mask string"""
        if len(text) <= keep_prefix + keep_suffix:
            return text

        prefix = text[:keep_prefix] if keep_prefix > 0 else ''
        suffix = text[-keep_suffix:] if keep_suffix > 0 else ''
        middle_length = len(text) - keep_prefix - keep_suffix

        return prefix + mask_char * middle_length + suffix

    def _hash_string(self, text: str) -> str:
        """Hash string"""
        return hashlib.sha256(text.encode()).hexdigest()[:16]

    def _shuffle_string(self, text: str) -> str:
        """Shuffle string"""
        chars = list(text)
        random.shuffle(chars)
        return ''.join(chars)

    def _random_replacement(self, text: str) -> str:
        """Random replace"""
        # 保持长度，随机替换字符
        replacement = ''
        for char in text:
            if char.isdigit():
                replacement += random.choice(string.digits)
            elif char.isalpha():
                if char.isupper():
                    replacement += random.choice(string.ascii_uppercase)
                else:
                    replacement += random.choice(string.ascii_lowercase)
            else:
                replacement += char
        return replacement

    def _compare_risk_level(self, level1: str, level2: str) -> int:
        """Compare risk level, return 1 if level1 > level2, -1 if level1 < level2, 0 if equal"""
        risk_order = {'no_risk': 0, 'low': 1, 'low_risk': 1, 'medium': 2, 'medium_risk': 2, 'high': 3, 'high_risk': 3}
        score1 = risk_order.get(level1, 0)
        score2 = risk_order.get(level2, 0)

        if score1 > score2:
            return 1
        elif score1 < score2:
            return -1
        else:
            return 0

    def create_entity_type(
        self,
        tenant_id: str,
        application_id: Optional[str] = None,
        entity_type: str = None,
        display_name: str = None,
        risk_level: str = None,
        pattern: str = None,
        anonymization_method: str = 'replace',
        anonymization_config: Optional[Dict[str, Any]] = None,
        check_input: bool = True,
        check_output: bool = True,
        is_global: bool = False,
        source_type: str = 'custom',
        template_id: Optional[str] = None
    ) -> DataSecurityEntityType:
        """Create sensitive data type configuration

        Args:
            tenant_id: Tenant ID
            application_id: Application ID (optional, None for global templates)
            source_type: 'system_template' (admin creates template), 'system_copy' (application's copy), 'custom' (user creates)
            template_id: UUID of the template if this is a copy
        """
        recognition_config = {
            'pattern': pattern,
            'check_input': check_input,
            'check_output': check_output
        }

        # For backward compatibility: is_global=True implies source_type='system_template'
        if is_global and source_type == 'custom':
            source_type = 'system_template'

        entity_type_obj = DataSecurityEntityType(
            tenant_id=tenant_id,
            application_id=application_id if not is_global else None,  # Global templates don't have application_id
            entity_type=entity_type,
            display_name=display_name,
            category=risk_level,  # Use category field to store risk level
            recognition_method='regex',
            recognition_config=recognition_config,
            anonymization_method=anonymization_method,
            anonymization_config=anonymization_config or {},
            is_global=is_global,
            source_type=source_type,
            template_id=template_id
        )

        self.db.add(entity_type_obj)
        self.db.commit()
        self.db.refresh(entity_type_obj)

        return entity_type_obj

    def update_entity_type(
        self,
        entity_type_id: str,
        tenant_id: str,
        application_id: Optional[str] = None,
        **kwargs
    ) -> Optional[DataSecurityEntityType]:
        """Update sensitive data type configuration

        Args:
            entity_type_id: Entity type ID to update
            tenant_id: Tenant ID
            application_id: Application ID (optional)
        """
        # Build query conditions
        conditions = [DataSecurityEntityType.id == entity_type_id]

        # Allow access if global template or belongs to the application
        if application_id:
            conditions.append(
                (DataSecurityEntityType.application_id == application_id) |
                (DataSecurityEntityType.is_global == True)
            )
        else:
            conditions.append(DataSecurityEntityType.is_global == True)

        entity_type = self.db.query(DataSecurityEntityType).filter(and_(*conditions)).first()

        if not entity_type:
            return None

        # Update fields
        if 'display_name' in kwargs:
            entity_type.display_name = kwargs['display_name']
        if 'risk_level' in kwargs:
            entity_type.category = kwargs['risk_level']
        if 'pattern' in kwargs:
            recognition_config = entity_type.recognition_config or {}
            recognition_config['pattern'] = kwargs['pattern']
            entity_type.recognition_config = recognition_config
        if 'check_input' in kwargs or 'check_output' in kwargs:
            recognition_config = entity_type.recognition_config or {}
            if 'check_input' in kwargs:
                recognition_config['check_input'] = kwargs['check_input']
            if 'check_output' in kwargs:
                recognition_config['check_output'] = kwargs['check_output']
            entity_type.recognition_config = recognition_config
        if 'anonymization_method' in kwargs:
            entity_type.anonymization_method = kwargs['anonymization_method']
        if 'anonymization_config' in kwargs:
            entity_type.anonymization_config = kwargs['anonymization_config']
        if 'is_active' in kwargs:
            entity_type.is_active = kwargs['is_active']

        entity_type.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(entity_type)

        return entity_type

    def delete_entity_type(self, entity_type_id: str, tenant_id: str, application_id: Optional[str] = None) -> bool:
        """Delete sensitive data type configuration

        Args:
            entity_type_id: Entity type ID to delete
            tenant_id: Tenant ID
            application_id: Application ID (optional)
        """
        conditions = [DataSecurityEntityType.id == entity_type_id]

        # Only allow deletion if it belongs to the application
        if application_id:
            conditions.append(DataSecurityEntityType.application_id == application_id)
        else:
            conditions.append(DataSecurityEntityType.tenant_id == tenant_id)

        entity_type = self.db.query(DataSecurityEntityType).filter(and_(*conditions)).first()

        if not entity_type:
            return False

        self.db.delete(entity_type)
        self.db.commit()

        return True

    def get_entity_types(
        self,
        tenant_id: str,
        application_id: Optional[str] = None,
        risk_level: Optional[str] = None,
        is_active: Optional[bool] = None
    ) -> List[DataSecurityEntityType]:
        """Get sensitive data type configuration list

        This method now automatically ensures application has copies of all system templates.

        Args:
            tenant_id: Tenant ID
            application_id: Application ID (optional)
            risk_level: Filter by risk level (optional)
            is_active: Filter by active status (optional)
        """
        # Ensure application has copies of all system templates
        if application_id:
            self.ensure_application_has_system_copies(tenant_id, application_id)

            # Get application's own entity types (both system_copy and custom)
            query = self.db.query(DataSecurityEntityType).filter(
                DataSecurityEntityType.application_id == application_id
            )
        else:
            # Fallback: get tenant's entity types (for backward compatibility)
            query = self.db.query(DataSecurityEntityType).filter(
                DataSecurityEntityType.tenant_id == tenant_id
            )

        if risk_level:
            query = query.filter(DataSecurityEntityType.category == risk_level)
        if is_active is not None:
            query = query.filter(DataSecurityEntityType.is_active == is_active)

        return query.order_by(DataSecurityEntityType.created_at.desc()).all()

    def disable_entity_type_for_application(self, tenant_id: str, application_id: str, entity_type: str) -> bool:
        """Disable an entity type for a specific application"""
        try:
            # Check if already disabled
            existing = self.db.query(TenantEntityTypeDisable).filter(
                and_(
                    TenantEntityTypeDisable.tenant_id == tenant_id,
                    TenantEntityTypeDisable.application_id == application_id,
                    TenantEntityTypeDisable.entity_type == entity_type
                )
            ).first()

            if existing:
                return True  # Already disabled

            # Create disable record
            disable_record = TenantEntityTypeDisable(
                tenant_id=tenant_id,
                application_id=application_id,
                entity_type=entity_type
            )
            self.db.add(disable_record)
            self.db.commit()
            return True
        except Exception as e:
            logger.error(f"Error disabling entity type {entity_type} for application {application_id}: {e}")
            self.db.rollback()
            return False

    def enable_entity_type_for_application(self, tenant_id: str, application_id: str, entity_type: str) -> bool:
        """Enable an entity type for a specific application (remove disable record)"""
        try:
            disable_record = self.db.query(TenantEntityTypeDisable).filter(
                and_(
                    TenantEntityTypeDisable.tenant_id == tenant_id,
                    TenantEntityTypeDisable.application_id == application_id,
                    TenantEntityTypeDisable.entity_type == entity_type
                )
            ).first()

            if disable_record:
                self.db.delete(disable_record)
                self.db.commit()
            return True
        except Exception as e:
            logger.error(f"Error enabling entity type {entity_type} for application {application_id}: {e}")
            self.db.rollback()
            return False

    def get_application_disabled_entity_types(self, tenant_id: str, application_id: str) -> List[str]:
        """Get list of disabled entity types for an application"""
        try:
            disabled_records = self.db.query(TenantEntityTypeDisable).filter(
                and_(
                    TenantEntityTypeDisable.tenant_id == tenant_id,
                    TenantEntityTypeDisable.application_id == application_id
                )
            ).all()
            return [record.entity_type for record in disabled_records]
        except Exception as e:
            logger.error(f"Error getting disabled entity types for application {application_id}: {e}")
            return []

    # Keep old tenant methods for backward compatibility
    def disable_entity_type_for_tenant(self, tenant_id: str, entity_type: str) -> bool:
        """Disable an entity type for a specific tenant (deprecated, use disable_entity_type_for_application)"""
        try:
            # Check if already disabled
            existing = self.db.query(TenantEntityTypeDisable).filter(
                and_(
                    TenantEntityTypeDisable.tenant_id == tenant_id,
                    TenantEntityTypeDisable.entity_type == entity_type
                )
            ).first()

            if existing:
                return True  # Already disabled

            # Create disable record
            disable_record = TenantEntityTypeDisable(
                tenant_id=tenant_id,
                entity_type=entity_type
            )
            self.db.add(disable_record)
            self.db.commit()
            return True
        except Exception as e:
            logger.error(f"Error disabling entity type {entity_type} for tenant {tenant_id}: {e}")
            self.db.rollback()
            return False

    def enable_entity_type_for_tenant(self, tenant_id: str, entity_type: str) -> bool:
        """Enable an entity type for a specific tenant (deprecated, use enable_entity_type_for_application)"""
        try:
            disable_record = self.db.query(TenantEntityTypeDisable).filter(
                and_(
                    TenantEntityTypeDisable.tenant_id == tenant_id,
                    TenantEntityTypeDisable.entity_type == entity_type
                )
            ).first()

            if disable_record:
                self.db.delete(disable_record)
                self.db.commit()
            return True
        except Exception as e:
            logger.error(f"Error enabling entity type {entity_type} for tenant {tenant_id}: {e}")
            self.db.rollback()
            return False

    def get_tenant_disabled_entity_types(self, tenant_id: str) -> List[str]:
        """Get list of disabled entity types for a tenant (deprecated, use get_application_disabled_entity_types)"""
        try:
            disabled_records = self.db.query(TenantEntityTypeDisable).filter(
                TenantEntityTypeDisable.tenant_id == tenant_id
            ).all()
            return [record.entity_type for record in disabled_records]
        except Exception as e:
            logger.error(f"Error getting disabled entity types for tenant {tenant_id}: {e}")
            return []
    
    def ensure_application_has_system_copies(self, tenant_id: str, application_id: str) -> int:
        """Ensure application has copies of all system templates

        This method:
        1. Finds all system templates (source_type='system_template')
        2. For each template, checks if application has a copy
        3. Creates missing copies with source_type='system_copy' and template_id set

        Returns:
            Number of copies created
        """
        try:
            # Get all system templates
            system_templates = self.db.query(DataSecurityEntityType).filter(
                DataSecurityEntityType.source_type == 'system_template'
            ).all()

            if not system_templates:
                return 0

            # Get application's existing entity types
            application_entity_types = self.db.query(DataSecurityEntityType).filter(
                DataSecurityEntityType.application_id == application_id
            ).all()

            # Create a set of template IDs that application already has copies of
            application_template_ids = set()
            for et in application_entity_types:
                if et.template_id:
                    application_template_ids.add(str(et.template_id))

            # Create copies for missing templates
            copies_created = 0
            for template in system_templates:
                template_id_str = str(template.id)

                # Skip if application already has a copy of this template
                if template_id_str in application_template_ids:
                    continue

                # Create a copy for this application
                recognition_config = template.recognition_config or {}
                copy = DataSecurityEntityType(
                    tenant_id=tenant_id,
                    application_id=application_id,
                    entity_type=template.entity_type,
                    display_name=template.display_name,
                    category=template.category,
                    recognition_method=template.recognition_method,
                    recognition_config=recognition_config.copy(),
                    anonymization_method=template.anonymization_method,
                    anonymization_config=(template.anonymization_config or {}).copy(),
                    is_active=template.is_active,
                    is_global=False,  # Copies are not global
                    source_type='system_copy',
                    template_id=template.id
                )

                self.db.add(copy)
                copies_created += 1
                logger.info(f"Created system copy of '{template.entity_type}' for application {application_id}")

            if copies_created > 0:
                self.db.commit()
                logger.info(f"Created {copies_created} system entity type copies for application {application_id}")

            return copies_created

        except Exception as e:
            logger.error(f"Error ensuring application {application_id} has system copies: {e}")
            self.db.rollback()
            return 0

    def ensure_tenant_has_system_copies(self, tenant_id: str) -> int:
        """Ensure tenant has copies of all system templates (deprecated, use ensure_application_has_system_copies)

        This method:
        1. Finds all system templates (source_type='system_template')
        2. For each template, checks if tenant has a copy
        3. Creates missing copies with source_type='system_copy' and template_id set

        Returns:
            Number of copies created
        """
        try:
            # Get all system templates
            system_templates = self.db.query(DataSecurityEntityType).filter(
                DataSecurityEntityType.source_type == 'system_template'
            ).all()

            if not system_templates:
                return 0

            # Get tenant's existing entity types
            tenant_entity_types = self.db.query(DataSecurityEntityType).filter(
                DataSecurityEntityType.tenant_id == tenant_id
            ).all()

            # Create a set of template IDs that tenant already has copies of
            tenant_template_ids = set()
            for et in tenant_entity_types:
                if et.template_id:
                    tenant_template_ids.add(str(et.template_id))

            # Create copies for missing templates
            copies_created = 0
            for template in system_templates:
                template_id_str = str(template.id)

                # Skip if tenant already has a copy of this template
                if template_id_str in tenant_template_ids:
                    continue

                # Create a copy for this tenant
                recognition_config = template.recognition_config or {}
                copy = DataSecurityEntityType(
                    tenant_id=tenant_id,
                    entity_type=template.entity_type,
                    display_name=template.display_name,
                    category=template.category,
                    recognition_method=template.recognition_method,
                    recognition_config=recognition_config.copy(),
                    anonymization_method=template.anonymization_method,
                    anonymization_config=(template.anonymization_config or {}).copy(),
                    is_active=template.is_active,
                    is_global=False,  # Copies are not global
                    source_type='system_copy',
                    template_id=template.id
                )

                self.db.add(copy)
                copies_created += 1
                logger.info(f"Created system copy of '{template.entity_type}' for tenant {tenant_id}")

            if copies_created > 0:
                self.db.commit()
                logger.info(f"Created {copies_created} system entity type copies for tenant {tenant_id}")

            return copies_created

        except Exception as e:
            logger.error(f"Error ensuring tenant {tenant_id} has system copies: {e}")
            self.db.rollback()
            return 0


def get_default_entity_types_config() -> List[Dict[str, Any]]:
    """Get default entity types configuration (used for global initialization)"""
    return [
        {
            'entity_type': 'ID_CARD_NUMBER_SYS',
            'display_name': 'ID Card Number',
            'risk_level': 'high',
            'pattern': r'[1-8]\d{5}(19|20)\d{2}((0[1-9])|(1[0-2]))((0[1-9])|([12]\d)|(3[01]))\d{3}[\dxX]',
            'anonymization_method': 'mask',
            'anonymization_config': {'mask_char': '*', 'keep_prefix': 3, 'keep_suffix': 4},
            'check_input': True,
            'check_output': True
        },
        {
            'entity_type': 'PHONE_NUMBER_SYS',
            'display_name': 'Phone Number',
            'risk_level': 'medium',
            'pattern': r'1[3-9]\d{9}',
            'anonymization_method': 'mask',
            'anonymization_config': {'mask_char': '*', 'keep_prefix': 3, 'keep_suffix': 4},
            'check_input': True,
            'check_output': True
        },
        {
            'entity_type': 'EMAIL_SYS',
            'display_name': 'Email',
            'risk_level': 'low',
            'pattern': r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}',
            'anonymization_method': 'mask',
            'anonymization_config': {'mask_char': '*', 'keep_prefix': 2, 'keep_suffix': 0},
            'check_input': True,
            'check_output': True
        },
        {
            'entity_type': 'BANK_CARD_NUMBER_SYS',
            'display_name': 'Bank Card Number',
            'risk_level': 'high',
            'pattern': r'\d{16,19}',
            'anonymization_method': 'mask',
            'anonymization_config': {'mask_char': '*', 'keep_prefix': 4, 'keep_suffix': 4},
            'check_input': True,
            'check_output': True
        },
        {
            'entity_type': 'PASSPORT_NUMBER_SYS',
            'display_name': 'Passport Number',
            'risk_level': 'high',
            'pattern': r'[EGP]\d{8}',
            'anonymization_method': 'mask',
            'anonymization_config': {'mask_char': '*', 'keep_prefix': 1, 'keep_suffix': 2},
            'check_input': True,
            'check_output': True
        },
        {
            'entity_type': 'IP_ADDRESS_SYS',
            'display_name': 'IP Address',
            'risk_level': 'low',
            'pattern': r'(?:\d{1,3}\.){3}\d{1,3}',
            'anonymization_method': 'replace',
            'anonymization_config': {'replacement': '<IP_ADDRESS>'},
            'check_input': True,
            'check_output': True
        }
    ]


def create_global_entity_types(db: Session, admin_tenant_id: str) -> int:
    """Create system template entity type configurations (called during system initialization)

    Args:
        db: Database session
        admin_tenant_id: Super admin tenant ID (used as creator of templates)

    Returns:
        Number of entity types created
    """
    service = DataSecurityService(db)
    default_entity_types = get_default_entity_types_config()

    created_count = 0
    for entity_data in default_entity_types:
        try:
            # Check if system template already exists
            existing = db.query(DataSecurityEntityType).filter(
                and_(
                    DataSecurityEntityType.entity_type == entity_data['entity_type'],
                    DataSecurityEntityType.source_type == 'system_template'
                )
            ).first()

            if not existing:
                service.create_entity_type(
                    tenant_id=admin_tenant_id,
                    entity_type=entity_data['entity_type'],
                    display_name=entity_data['display_name'],
                    risk_level=entity_data['risk_level'],
                    pattern=entity_data['pattern'],
                    anonymization_method=entity_data['anonymization_method'],
                    anonymization_config=entity_data['anonymization_config'],
                    check_input=entity_data['check_input'],
                    check_output=entity_data['check_output'],
                    is_global=True,  # Keep for backward compatibility
                    source_type='system_template'
                )
                created_count += 1
                logger.info(f"Created system template entity type: {entity_data['entity_type']}")
        except Exception as e:
            logger.error(f"Failed to create system template entity type {entity_data['entity_type']}: {e}")

    return created_count


def create_user_default_entity_types(db: Session, tenant_id: str) -> int:
    """Create default entity type configuration for new tenant (DEPRECATED)

    This function is now deprecated and does nothing. Global entity types are created
    during system initialization via migration. This function is kept for backward
    compatibility but no longer creates any entity types.

    Note: For backward compatibility, keep function name create_user_default_entity_types, parameter name tenant_id, but actually process tenant_id
    """
    # No longer create entity types for individual users
    # Global entity types should already exist from system initialization
    logger.info(f"Skipping entity type creation for tenant {tenant_id} - using global defaults")
    return 0

