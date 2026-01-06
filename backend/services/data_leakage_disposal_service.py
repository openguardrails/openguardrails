"""
Data Leakage Disposal Service

Handles data leakage disposal policy management and private model selection.
"""

import logging
from typing import Optional, Tuple
from sqlalchemy.orm import Session
from sqlalchemy import and_, or_

from database.models import (
    TenantDataLeakagePolicy,
    ApplicationDataLeakagePolicy,
    UpstreamApiConfig,
    Application
)
from utils.logger import setup_logger

logger = setup_logger()


class DataLeakageDisposalService:
    """Service for managing data leakage disposal policies"""

    # Valid disposal actions
    VALID_ACTIONS = {'block', 'switch_private_model', 'anonymize', 'pass'}

    # Risk levels
    RISK_LEVELS = {'high_risk', 'medium_risk', 'low_risk', 'no_risk'}

    def __init__(self, db: Session):
        """
        Initialize disposal service

        Args:
            db: Database session
        """
        self.db = db

    def get_tenant_policy(self, tenant_id: str) -> Optional[TenantDataLeakagePolicy]:
        """
        Get tenant's default data leakage policy

        If policy doesn't exist, create a default one.

        Args:
            tenant_id: Tenant ID

        Returns:
            TenantDataLeakagePolicy or None if tenant not found
        """
        try:
            # Check if policy exists
            policy = self.db.query(TenantDataLeakagePolicy).filter(
                TenantDataLeakagePolicy.tenant_id == tenant_id
            ).first()

            if policy:
                return policy

            # Policy doesn't exist - create default
            logger.info(f"Creating default tenant policy for tenant {tenant_id}")

            default_policy = TenantDataLeakagePolicy(tenant_id=tenant_id)
            self.db.add(default_policy)
            self.db.commit()
            self.db.refresh(default_policy)

            logger.info(f"Created default tenant policy for tenant {tenant_id}")
            return default_policy

        except Exception as e:
            logger.error(f"Error getting tenant policy: {e}", exc_info=True)
            self.db.rollback()
            return None

    def get_disposal_policy(self, application_id: str) -> Optional[ApplicationDataLeakagePolicy]:
        """
        Get application's data leakage disposal policy

        If policy doesn't exist, create a default one (with NULL overrides).

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

            # Policy doesn't exist - create default with NULL overrides (inherits from tenant)
            logger.info(f"Creating default disposal policy for application {application_id}")

            # Get application to find tenant_id
            application = self.db.query(Application).filter(
                Application.id == application_id
            ).first()

            if not application:
                logger.error(f"Application {application_id} not found")
                return None

            # Create default policy with NULL overrides (will inherit from tenant defaults)
            default_policy = ApplicationDataLeakagePolicy(
                tenant_id=application.tenant_id,
                application_id=application_id,
                # All fields default to NULL = inherit from tenant
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

    def get_disposal_action(self, application_id: str, risk_level: str, direction: str = 'input') -> str:
        """
        Get disposal action for a specific risk level and direction

        Args:
            application_id: Application ID
            risk_level: 'high_risk' | 'medium_risk' | 'low_risk' | 'no_risk'
            direction: 'input' (default) or 'output'

        Returns:
            For input: 'block' | 'switch_private_model' | 'anonymize' | 'pass'
            For output: boolean converted to action ('anonymize' or 'pass')
        """
        if risk_level == 'no_risk':
            return 'pass'

        app_policy = self.get_disposal_policy(application_id)
        if not app_policy:
            # Fallback to safe defaults if policy retrieval fails
            logger.warning(f"No policy found for application {application_id}, using defaults")
            if direction == 'input':
                return {
                    'high_risk': 'block',
                    'medium_risk': 'switch_private_model',
                    'low_risk': 'anonymize'
                }.get(risk_level, 'block')
            else:  # output
                # Default: anonymize high/medium, pass low
                return 'anonymize' if risk_level in ['high_risk', 'medium_risk'] else 'pass'

        # Get tenant policy for defaults
        tenant_policy = self.get_tenant_policy(str(app_policy.tenant_id))
        if not tenant_policy:
            logger.warning(f"No tenant policy found, using hardcoded defaults")
            if direction == 'input':
                return {
                    'high_risk': 'block',
                    'medium_risk': 'switch_private_model',
                    'low_risk': 'anonymize'
                }.get(risk_level, 'block')
            else:
                return 'anonymize' if risk_level in ['high_risk', 'medium_risk'] else 'pass'

        if direction == 'input':
            # Resolve input actions (use override if present, else tenant default)
            action_map = {
                'high_risk': app_policy.input_high_risk_action or tenant_policy.default_input_high_risk_action,
                'medium_risk': app_policy.input_medium_risk_action or tenant_policy.default_input_medium_risk_action,
                'low_risk': app_policy.input_low_risk_action or tenant_policy.default_input_low_risk_action
            }
        else:  # output
            # Resolve output anonymization flags (use override if present, else tenant default)
            anonymize_map = {
                'high_risk': (app_policy.output_high_risk_anonymize
                             if app_policy.output_high_risk_anonymize is not None
                             else tenant_policy.default_output_high_risk_anonymize),
                'medium_risk': (app_policy.output_medium_risk_anonymize
                               if app_policy.output_medium_risk_anonymize is not None
                               else tenant_policy.default_output_medium_risk_anonymize),
                'low_risk': (app_policy.output_low_risk_anonymize
                            if app_policy.output_low_risk_anonymize is not None
                            else tenant_policy.default_output_low_risk_anonymize)
            }
            should_anonymize = anonymize_map.get(risk_level, False)
            action = 'anonymize' if should_anonymize else 'pass'
            logger.debug(f"Output disposal action for {risk_level}: {action}")
            return action

        action = action_map.get(risk_level, 'block')
        logger.debug(f"Input disposal action for {risk_level}: {action}")
        return action

    def get_private_model(
        self,
        application_id: str,
        tenant_id: str
    ) -> Optional[UpstreamApiConfig]:
        """
        Get private model for switching (Simplified design)

        Priority:
        1. Application-configured private model (app_policy.private_model_id)
        2. Tenant's default private model (is_default_private_model=True)
        3. First available private model (fallback)

        Args:
            application_id: Application ID
            tenant_id: Tenant ID

        Returns:
            UpstreamApiConfig or None if no private model available
        """
        try:
            # Get application's disposal policy
            app_policy = self.get_disposal_policy(application_id)

            # 1. Check if application has configured a specific private model override
            if app_policy and app_policy.private_model_id:
                private_model = self.db.query(UpstreamApiConfig).filter(
                    and_(
                        UpstreamApiConfig.id == app_policy.private_model_id,
                        UpstreamApiConfig.is_private_model == True,
                        UpstreamApiConfig.is_active == True
                    )
                ).first()

                if private_model:
                    logger.info(f"Using application-configured private model: {private_model.config_name}")
                    return private_model
                else:
                    logger.warning(f"Application's configured private model {app_policy.private_model_id} not found or inactive")

            # 2. Check for tenant's default private model
            default_private_model = self.db.query(UpstreamApiConfig).filter(
                and_(
                    UpstreamApiConfig.tenant_id == tenant_id,
                    UpstreamApiConfig.is_private_model == True,
                    UpstreamApiConfig.is_default_private_model == True,
                    UpstreamApiConfig.is_active == True
                )
            ).first()

            if default_private_model:
                logger.info(f"Using tenant's default private model: {default_private_model.config_name}")
                return default_private_model

            # 3. Fallback: Get first available private model
            fallback_private_model = self.db.query(UpstreamApiConfig).filter(
                and_(
                    UpstreamApiConfig.tenant_id == tenant_id,
                    UpstreamApiConfig.is_private_model == True,
                    UpstreamApiConfig.is_active == True
                )
            ).order_by(UpstreamApiConfig.created_at.asc()).first()

            if fallback_private_model:
                logger.info(f"Using first available private model: {fallback_private_model.config_name}")
                return fallback_private_model

            # No private model found
            logger.warning(f"No private model found for tenant {tenant_id}")
            return None

        except Exception as e:
            logger.error(f"Error getting private model: {e}", exc_info=True)
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

        # 'switch_private_model' requires a private model to be available
        if action == 'switch_private_model':
            private_model = self.get_private_model(application_id, tenant_id)
            if private_model:
                return True, ""
            else:
                return False, "No private model configured. Please configure a data-private model first."

        return True, ""

    def get_policy_settings(self, application_id: str) -> dict:
        """
        Get policy settings including feature flags (resolved from app override or tenant default)

        Args:
            application_id: Application ID

        Returns:
            Dictionary with policy settings
        """
        app_policy = self.get_disposal_policy(application_id)

        if not app_policy:
            return {
                'enable_format_detection': True,
                'enable_smart_segmentation': True
            }

        # Get tenant policy for defaults
        tenant_policy = self.get_tenant_policy(str(app_policy.tenant_id))

        # Resolve values (use override if present, else tenant default)
        enable_format_detection = (app_policy.enable_format_detection
                                   if app_policy.enable_format_detection is not None
                                   else (tenant_policy.default_enable_format_detection if tenant_policy else True))

        enable_smart_segmentation = (app_policy.enable_smart_segmentation
                                     if app_policy.enable_smart_segmentation is not None
                                     else (tenant_policy.default_enable_smart_segmentation if tenant_policy else True))

        return {
            'enable_format_detection': enable_format_detection,
            'enable_smart_segmentation': enable_smart_segmentation
        }

    def update_disposal_policy(
        self,
        application_id: str,
        input_high_risk_action: Optional[str] = None,
        input_medium_risk_action: Optional[str] = None,
        input_low_risk_action: Optional[str] = None,
        output_high_risk_anonymize: Optional[bool] = None,
        output_medium_risk_anonymize: Optional[bool] = None,
        output_low_risk_anonymize: Optional[bool] = None,
        private_model_id: Optional[str] = None,
        enable_format_detection: Optional[bool] = None,
        enable_smart_segmentation: Optional[bool] = None
    ) -> Tuple[bool, str, Optional[ApplicationDataLeakagePolicy]]:
        """
        Update disposal policy (deprecated - use API endpoints directly)

        This method is kept for backward compatibility but new code should use
        the data_leakage_policy_api endpoints directly.

        Args:
            application_id: Application ID
            input_high_risk_action: Input action for high risk (optional, NULL = inherit)
            input_medium_risk_action: Input action for medium risk (optional, NULL = inherit)
            input_low_risk_action: Input action for low risk (optional, NULL = inherit)
            output_high_risk_anonymize: Anonymize high risk output (optional, NULL = inherit)
            output_medium_risk_anonymize: Anonymize medium risk output (optional, NULL = inherit)
            output_low_risk_anonymize: Anonymize low risk output (optional, NULL = inherit)
            private_model_id: Private model ID (optional, NULL = inherit)
            enable_format_detection: Enable format detection (optional, NULL = inherit)
            enable_smart_segmentation: Enable smart segmentation (optional, NULL = inherit)

        Returns:
            Tuple of (success, message, updated_policy)
        """
        try:
            policy = self.get_disposal_policy(application_id)
            if not policy:
                return False, "Failed to retrieve or create policy", None

            # Validate actions if provided
            for action_name, action_value in [
                ('input_high_risk_action', input_high_risk_action),
                ('input_medium_risk_action', input_medium_risk_action),
                ('input_low_risk_action', input_low_risk_action)
            ]:
                if action_value and action_value not in self.VALID_ACTIONS:
                    return False, f"Invalid {action_name}: {action_value}", None

            # Update fields if provided
            if input_high_risk_action is not None:
                policy.input_high_risk_action = input_high_risk_action
            if input_medium_risk_action is not None:
                policy.input_medium_risk_action = input_medium_risk_action
            if input_low_risk_action is not None:
                policy.input_low_risk_action = input_low_risk_action
            if output_high_risk_anonymize is not None:
                policy.output_high_risk_anonymize = output_high_risk_anonymize
            if output_medium_risk_anonymize is not None:
                policy.output_medium_risk_anonymize = output_medium_risk_anonymize
            if output_low_risk_anonymize is not None:
                policy.output_low_risk_anonymize = output_low_risk_anonymize
            if private_model_id is not None:
                policy.private_model_id = private_model_id
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

    def list_available_private_models(self, tenant_id: str) -> list:
        """
        List all available private models for a tenant

        Args:
            tenant_id: Tenant ID

        Returns:
            List of safe UpstreamApiConfig objects
        """
        try:
            private_models = self.db.query(UpstreamApiConfig).filter(
                and_(
                    UpstreamApiConfig.tenant_id == tenant_id,
                    UpstreamApiConfig.is_private_model == True,
                    UpstreamApiConfig.is_active == True
                )
            ).order_by(
                UpstreamApiConfig.is_default_private_model.desc(),
                UpstreamApiConfig.created_at.asc()
            ).all()

            return private_models

        except Exception as e:
            logger.error(f"Error listing private models: {e}", exc_info=True)
            return []
