"""
Data Leakage Disposal Service

Handles data leakage disposal policy management and safe model selection.
"""

import logging
from typing import Optional, Tuple
from sqlalchemy.orm import Session
from sqlalchemy import and_, or_

from database.models import (
    ApplicationDataLeakagePolicy,
    UpstreamApiConfig,
    Application
)
from utils.logger import setup_logger

logger = setup_logger()


class DataLeakageDisposalService:
    """Service for managing data leakage disposal policies"""

    # Valid disposal actions
    VALID_ACTIONS = {'block', 'switch_safe_model', 'anonymize', 'pass'}

    # Risk levels
    RISK_LEVELS = {'high_risk', 'medium_risk', 'low_risk', 'no_risk'}

    def __init__(self, db: Session):
        """
        Initialize disposal service

        Args:
            db: Database session
        """
        self.db = db

    def get_disposal_policy(self, application_id: str) -> Optional[ApplicationDataLeakagePolicy]:
        """
        Get application's data leakage disposal policy

        If policy doesn't exist, create a default one.

        Args:
            application_id: Application ID

        Returns:
            ApplicationDataLeakagePolicy or None if application not found
        """
        try:
            # Check if policy exists
            policy = self.db.query(ApplicationDataLeakagePolicy).filter(
                ApplicationDataLeakagePolicy.application_id == application_id
            ).first()

            if policy:
                return policy

            # Policy doesn't exist - create default
            logger.info(f"Creating default disposal policy for application {application_id}")

            # Get application to find tenant_id
            application = self.db.query(Application).filter(
                Application.id == application_id
            ).first()

            if not application:
                logger.error(f"Application {application_id} not found")
                return None

            # Create default policy
            default_policy = ApplicationDataLeakagePolicy(
                tenant_id=application.tenant_id,
                application_id=application_id,
                high_risk_action='block',
                medium_risk_action='switch_safe_model',
                low_risk_action='anonymize',
                enable_format_detection=True,
                enable_smart_segmentation=True
            )

            self.db.add(default_policy)
            self.db.commit()
            self.db.refresh(default_policy)

            logger.info(f"Created default disposal policy for application {application_id}")
            return default_policy

        except Exception as e:
            logger.error(f"Error getting disposal policy: {e}", exc_info=True)
            self.db.rollback()
            return None

    def get_disposal_action(self, application_id: str, risk_level: str) -> str:
        """
        Get disposal action for a specific risk level

        Args:
            application_id: Application ID
            risk_level: 'high_risk' | 'medium_risk' | 'low_risk' | 'no_risk'

        Returns:
            Disposal action: 'block' | 'switch_safe_model' | 'anonymize' | 'pass'
        """
        if risk_level == 'no_risk':
            return 'pass'

        policy = self.get_disposal_policy(application_id)
        if not policy:
            # Fallback to safe defaults if policy retrieval fails
            logger.warning(f"No policy found for application {application_id}, using defaults")
            return {
                'high_risk': 'block',
                'medium_risk': 'switch_safe_model',
                'low_risk': 'anonymize'
            }.get(risk_level, 'block')

        # Map risk level to action
        action_map = {
            'high_risk': policy.high_risk_action,
            'medium_risk': policy.medium_risk_action,
            'low_risk': policy.low_risk_action
        }

        action = action_map.get(risk_level, 'block')
        logger.debug(f"Disposal action for {risk_level}: {action}")
        return action

    def get_safe_model(
        self,
        application_id: str,
        tenant_id: str
    ) -> Optional[UpstreamApiConfig]:
        """
        Get safe model for switching

        Priority:
        1. Application-configured safe model (policy.safe_model_id)
        2. Tenant's default safe model (is_default_safe_model=True)
        3. Tenant's highest priority safe model (by safe_model_priority DESC)

        Args:
            application_id: Application ID
            tenant_id: Tenant ID

        Returns:
            UpstreamApiConfig or None if no safe model available
        """
        try:
            # Get application's disposal policy
            policy = self.get_disposal_policy(application_id)

            # 1. Check if application has configured a specific safe model
            if policy and policy.safe_model_id:
                safe_model = self.db.query(UpstreamApiConfig).filter(
                    and_(
                        UpstreamApiConfig.id == policy.safe_model_id,
                        UpstreamApiConfig.is_data_safe == True,
                        UpstreamApiConfig.is_active == True
                    )
                ).first()

                if safe_model:
                    logger.info(f"Using application-configured safe model: {safe_model.config_name}")
                    return safe_model
                else:
                    logger.warning(f"Application's configured safe model {policy.safe_model_id} not found or inactive")

            # 2. Check for tenant's default safe model
            default_safe_model = self.db.query(UpstreamApiConfig).filter(
                and_(
                    UpstreamApiConfig.tenant_id == tenant_id,
                    UpstreamApiConfig.is_data_safe == True,
                    UpstreamApiConfig.is_default_safe_model == True,
                    UpstreamApiConfig.is_active == True
                )
            ).first()

            if default_safe_model:
                logger.info(f"Using tenant's default safe model: {default_safe_model.config_name}")
                return default_safe_model

            # 3. Get highest priority safe model
            priority_safe_model = self.db.query(UpstreamApiConfig).filter(
                and_(
                    UpstreamApiConfig.tenant_id == tenant_id,
                    UpstreamApiConfig.is_data_safe == True,
                    UpstreamApiConfig.is_active == True
                )
            ).order_by(
                UpstreamApiConfig.safe_model_priority.desc(),
                UpstreamApiConfig.created_at.asc()
            ).first()

            if priority_safe_model:
                logger.info(f"Using highest priority safe model: {priority_safe_model.config_name}")
                return priority_safe_model

            # No safe model found
            logger.warning(f"No safe model found for tenant {tenant_id}")
            return None

        except Exception as e:
            logger.error(f"Error getting safe model: {e}", exc_info=True)
            return None

    def validate_disposal_action(
        self,
        action: str,
        tenant_id: str,
        application_id: str
    ) -> Tuple[bool, str]:
        """
        Validate if a disposal action can be executed

        Args:
            action: Disposal action to validate
            tenant_id: Tenant ID
            application_id: Application ID

        Returns:
            Tuple of (is_valid, error_message)
            - is_valid: True if action can be executed
            - error_message: Description of why action is invalid (empty if valid)
        """
        if action not in self.VALID_ACTIONS:
            return False, f"Invalid action '{action}'. Must be one of: {', '.join(self.VALID_ACTIONS)}"

        # 'pass', 'block', and 'anonymize' don't require additional resources
        if action in {'pass', 'block', 'anonymize'}:
            return True, ""

        # 'switch_safe_model' requires a safe model to be available
        if action == 'switch_safe_model':
            safe_model = self.get_safe_model(application_id, tenant_id)
            if safe_model:
                return True, ""
            else:
                return False, "No safe model configured. Please configure a data-safe model first."

        return True, ""

    def get_policy_settings(self, application_id: str) -> dict:
        """
        Get policy settings including feature flags

        Args:
            application_id: Application ID

        Returns:
            Dictionary with policy settings
        """
        policy = self.get_disposal_policy(application_id)

        if not policy:
            return {
                'enable_format_detection': True,
                'enable_smart_segmentation': True
            }

        return {
            'enable_format_detection': policy.enable_format_detection,
            'enable_smart_segmentation': policy.enable_smart_segmentation
        }

    def update_disposal_policy(
        self,
        application_id: str,
        high_risk_action: Optional[str] = None,
        medium_risk_action: Optional[str] = None,
        low_risk_action: Optional[str] = None,
        safe_model_id: Optional[str] = None,
        enable_format_detection: Optional[bool] = None,
        enable_smart_segmentation: Optional[bool] = None
    ) -> Tuple[bool, str, Optional[ApplicationDataLeakagePolicy]]:
        """
        Update disposal policy

        Args:
            application_id: Application ID
            high_risk_action: Action for high risk (optional)
            medium_risk_action: Action for medium risk (optional)
            low_risk_action: Action for low risk (optional)
            safe_model_id: Safe model ID (optional, can be None to unset)
            enable_format_detection: Enable format detection (optional)
            enable_smart_segmentation: Enable smart segmentation (optional)

        Returns:
            Tuple of (success, message, updated_policy)
        """
        try:
            policy = self.get_disposal_policy(application_id)
            if not policy:
                return False, "Failed to retrieve or create policy", None

            # Validate actions if provided
            for action_name, action_value in [
                ('high_risk_action', high_risk_action),
                ('medium_risk_action', medium_risk_action),
                ('low_risk_action', low_risk_action)
            ]:
                if action_value and action_value not in self.VALID_ACTIONS:
                    return False, f"Invalid {action_name}: {action_value}", None

            # Update fields if provided
            if high_risk_action is not None:
                policy.high_risk_action = high_risk_action
            if medium_risk_action is not None:
                policy.medium_risk_action = medium_risk_action
            if low_risk_action is not None:
                policy.low_risk_action = low_risk_action
            if safe_model_id is not None:
                policy.safe_model_id = safe_model_id
            if enable_format_detection is not None:
                policy.enable_format_detection = enable_format_detection
            if enable_smart_segmentation is not None:
                policy.enable_smart_segmentation = enable_smart_segmentation

            self.db.commit()
            self.db.refresh(policy)

            logger.info(f"Updated disposal policy for application {application_id}")
            return True, "Policy updated successfully", policy

        except Exception as e:
            logger.error(f"Error updating disposal policy: {e}", exc_info=True)
            self.db.rollback()
            return False, f"Error updating policy: {str(e)}", None

    def list_available_safe_models(self, tenant_id: str) -> list:
        """
        List all available safe models for a tenant

        Args:
            tenant_id: Tenant ID

        Returns:
            List of safe UpstreamApiConfig objects
        """
        try:
            safe_models = self.db.query(UpstreamApiConfig).filter(
                and_(
                    UpstreamApiConfig.tenant_id == tenant_id,
                    UpstreamApiConfig.is_data_safe == True,
                    UpstreamApiConfig.is_active == True
                )
            ).order_by(
                UpstreamApiConfig.is_default_safe_model.desc(),
                UpstreamApiConfig.safe_model_priority.desc(),
                UpstreamApiConfig.created_at.asc()
            ).all()

            return safe_models

        except Exception as e:
            logger.error(f"Error listing safe models: {e}", exc_info=True)
            return []
