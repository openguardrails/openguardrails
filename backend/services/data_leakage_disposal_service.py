"""
Data Masking Disposal Service

Handles data masking disposal policy management and private model selection.
"""

import logging
from typing import Optional, Tuple
from sqlalchemy.orm import Session
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import and_, or_, select

from database.models import (
    TenantDataLeakagePolicy,
    ApplicationDataLeakagePolicy,
    UpstreamApiConfig,
)
from utils.logger import setup_logger
from services.workspace_resolver import get_workspace_id_for_app, get_workspace_id_for_app_async

logger = setup_logger()


class DataLeakageDisposalService:
    """Service for managing data masking disposal policies"""

    # Valid disposal actions
    # - block: Block the request entirely
    # - switch_private_model: Switch to a private/on-premise model
    # - anonymize: Anonymize sensitive data (one-way)
    # - anonymize_restore: Anonymize with numbered placeholders, restore in output
    # - pass: Allow the request (audit only)
    VALID_ACTIONS = {'block', 'switch_private_model', 'anonymize', 'anonymize_restore', 'pass'}

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
        Get tenant's default data masking policy

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
        Get workspace-level data masking disposal policy for an application.

        Resolves application_id → workspace_id, then queries policy by workspace_id.
        Returns None if no policy exists (does not auto-create at app level).

        Args:
            application_id: Application ID

        Returns:
            ApplicationDataLeakagePolicy or None
        """
        try:
            # Resolve application → workspace
            workspace_id = get_workspace_id_for_app(self.db, application_id)

            if not workspace_id:
                logger.warning(f"Could not resolve workspace for app {application_id}")
                return None

            # Query workspace-level policy
            ws_policy = self.db.query(ApplicationDataLeakagePolicy).filter(
                ApplicationDataLeakagePolicy.workspace_id == workspace_id
            ).first()

            if ws_policy:
                return ws_policy

            # No workspace policy found
            logger.debug(f"No disposal policy found for workspace {workspace_id} (app {application_id})")
            return None

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
            # Resolve output actions (use override if present, else tenant default)
            # Uses the new output_xxx_risk_action fields (block/anonymize/pass)
            action_map = {
                'high_risk': app_policy.output_high_risk_action or tenant_policy.default_output_high_risk_action,
                'medium_risk': app_policy.output_medium_risk_action or tenant_policy.default_output_medium_risk_action,
                'low_risk': app_policy.output_low_risk_action or tenant_policy.default_output_low_risk_action
            }

        action = action_map.get(risk_level, 'block')
        logger.debug(f"{direction.capitalize()} disposal action for {risk_level}: {action}")
        return action

    def get_general_risk_action(self, application_id: str, risk_level: str, direction: str = 'input') -> str:
        """
        Get action for general risks (security, safety, compliance)

        Args:
            application_id: Application ID
            risk_level: 'high_risk' | 'medium_risk' | 'low_risk' | 'no_risk'
            direction: 'input' (default) or 'output'

        Returns:
            'block' | 'replace' | 'pass'
        """
        if risk_level == 'no_risk':
            return 'pass'

        app_policy = self.get_disposal_policy(application_id)
        if not app_policy:
            # Fallback to safe defaults if policy retrieval fails
            logger.warning(f"No policy found for application {application_id}, using general risk defaults")
            return {
                'high_risk': 'block',
                'medium_risk': 'replace',
                'low_risk': 'pass'
            }.get(risk_level, 'block')

        # Get tenant policy for defaults
        tenant_policy = self.get_tenant_policy(str(app_policy.tenant_id))
        if not tenant_policy:
            logger.warning(f"No tenant policy found, using hardcoded general risk defaults")
            return {
                'high_risk': 'block',
                'medium_risk': 'replace',
                'low_risk': 'pass'
            }.get(risk_level, 'block')

        # Resolve general risk actions based on direction (use override if present, else tenant default)
        if direction == 'input':
            action_map = {
                'high_risk': getattr(app_policy, 'general_input_high_risk_action', None) or getattr(tenant_policy, 'default_general_input_high_risk_action', None) or getattr(tenant_policy, 'default_general_high_risk_action', 'block') or 'block',
                'medium_risk': getattr(app_policy, 'general_input_medium_risk_action', None) or getattr(tenant_policy, 'default_general_input_medium_risk_action', None) or getattr(tenant_policy, 'default_general_medium_risk_action', 'replace') or 'replace',
                'low_risk': getattr(app_policy, 'general_input_low_risk_action', None) or getattr(tenant_policy, 'default_general_input_low_risk_action', None) or getattr(tenant_policy, 'default_general_low_risk_action', 'pass') or 'pass'
            }
        else:  # output
            action_map = {
                'high_risk': getattr(app_policy, 'general_output_high_risk_action', None) or getattr(tenant_policy, 'default_general_output_high_risk_action', None) or getattr(tenant_policy, 'default_general_high_risk_action', 'block') or 'block',
                'medium_risk': getattr(app_policy, 'general_output_medium_risk_action', None) or getattr(tenant_policy, 'default_general_output_medium_risk_action', None) or getattr(tenant_policy, 'default_general_medium_risk_action', 'replace') or 'replace',
                'low_risk': getattr(app_policy, 'general_output_low_risk_action', None) or getattr(tenant_policy, 'default_general_output_low_risk_action', None) or getattr(tenant_policy, 'default_general_low_risk_action', 'pass') or 'pass'
            }

        action = action_map.get(risk_level, 'pass')
        logger.debug(f"General {direction} risk action for {risk_level}: {action}")
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


# ---------------------------------------------------------------------------
# Phase 3 — async sibling class.
#
# Mirrors the public surface that the detection hot path needs
# (`get_general_risk_action`, `get_disposal_action`, `get_private_model`)
# plus the two helpers they share (`get_disposal_policy`,
# `get_tenant_policy`). The 6 router callers that still use the sync
# class are unaffected — they keep using `DataLeakageDisposalService`.
#
# Why a sibling class instead of mixed methods on one class: an instance
# binds to a single session, and mixing AsyncSession with sync `.query()`
# calls on the same instance would deadlock or raise MissingGreenlet at
# runtime. A separate class makes "this instance is bound to an async
# session" enforceable at construction time.
# ---------------------------------------------------------------------------


class AsyncDataLeakageDisposalService:
    """Async variant of DataLeakageDisposalService for the detection hot path.

    Implements the methods that DetectionGuardrailService needs; routers
    and other admin code keep using the sync class.
    """

    VALID_ACTIONS = DataLeakageDisposalService.VALID_ACTIONS
    RISK_LEVELS = DataLeakageDisposalService.RISK_LEVELS

    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_tenant_policy(self, tenant_id: str) -> Optional[TenantDataLeakagePolicy]:
        """Get tenant's default data masking policy. Auto-creates a default
        if missing (matching the sync version's behavior)."""
        try:
            res = await self.db.execute(
                select(TenantDataLeakagePolicy).where(
                    TenantDataLeakagePolicy.tenant_id == tenant_id
                )
            )
            policy = res.scalar_one_or_none()
            if policy:
                return policy

            logger.info(f"Creating default tenant policy for tenant {tenant_id}")
            default_policy = TenantDataLeakagePolicy(tenant_id=tenant_id)
            self.db.add(default_policy)
            await self.db.commit()
            await self.db.refresh(default_policy)
            logger.info(f"Created default tenant policy for tenant {tenant_id}")
            return default_policy

        except Exception as e:
            logger.error(f"Error getting tenant policy: {e}", exc_info=True)
            await self.db.rollback()
            return None

    async def get_disposal_policy(self, application_id: str) -> Optional[ApplicationDataLeakagePolicy]:
        """Resolve workspace-level disposal policy for an application.
        Returns None if no policy exists (does not auto-create)."""
        try:
            workspace_id = await get_workspace_id_for_app_async(self.db, application_id)
            if not workspace_id:
                logger.warning(f"Could not resolve workspace for app {application_id}")
                return None

            res = await self.db.execute(
                select(ApplicationDataLeakagePolicy).where(
                    ApplicationDataLeakagePolicy.workspace_id == workspace_id
                )
            )
            ws_policy = res.scalar_one_or_none()
            if ws_policy:
                return ws_policy

            logger.debug(f"No disposal policy found for workspace {workspace_id} (app {application_id})")
            return None

        except Exception as e:
            logger.error(f"Error getting disposal policy: {e}", exc_info=True)
            await self.db.rollback()
            return None

    async def get_disposal_action(self, application_id: str, risk_level: str, direction: str = 'input') -> str:
        """Returns the action for a DLP risk level/direction. See sync version for semantics."""
        if risk_level == 'no_risk':
            return 'pass'

        app_policy = await self.get_disposal_policy(application_id)
        if not app_policy:
            logger.warning(f"No policy found for application {application_id}, using defaults")
            if direction == 'input':
                return {'high_risk': 'block', 'medium_risk': 'switch_private_model', 'low_risk': 'anonymize'}.get(risk_level, 'block')
            return 'anonymize' if risk_level in ('high_risk', 'medium_risk') else 'pass'

        tenant_policy = await self.get_tenant_policy(str(app_policy.tenant_id))
        if not tenant_policy:
            logger.warning("No tenant policy found, using hardcoded defaults")
            if direction == 'input':
                return {'high_risk': 'block', 'medium_risk': 'switch_private_model', 'low_risk': 'anonymize'}.get(risk_level, 'block')
            return 'anonymize' if risk_level in ('high_risk', 'medium_risk') else 'pass'

        if direction == 'input':
            action_map = {
                'high_risk': app_policy.input_high_risk_action or tenant_policy.default_input_high_risk_action,
                'medium_risk': app_policy.input_medium_risk_action or tenant_policy.default_input_medium_risk_action,
                'low_risk': app_policy.input_low_risk_action or tenant_policy.default_input_low_risk_action,
            }
        else:
            action_map = {
                'high_risk': app_policy.output_high_risk_action or tenant_policy.default_output_high_risk_action,
                'medium_risk': app_policy.output_medium_risk_action or tenant_policy.default_output_medium_risk_action,
                'low_risk': app_policy.output_low_risk_action or tenant_policy.default_output_low_risk_action,
            }
        action = action_map.get(risk_level, 'block')
        logger.debug(f"{direction.capitalize()} disposal action for {risk_level}: {action}")
        return action

    async def get_general_risk_action(self, application_id: str, risk_level: str, direction: str = 'input') -> str:
        """Returns block/replace/pass for general (security/compliance) risks."""
        if risk_level == 'no_risk':
            return 'pass'

        app_policy = await self.get_disposal_policy(application_id)
        if not app_policy:
            logger.warning(f"No policy found for application {application_id}, using general risk defaults")
            return {'high_risk': 'block', 'medium_risk': 'replace', 'low_risk': 'pass'}.get(risk_level, 'block')

        tenant_policy = await self.get_tenant_policy(str(app_policy.tenant_id))
        if not tenant_policy:
            logger.warning("No tenant policy found, using hardcoded general risk defaults")
            return {'high_risk': 'block', 'medium_risk': 'replace', 'low_risk': 'pass'}.get(risk_level, 'block')

        # Same chained-default resolution as the sync version.
        if direction == 'input':
            action_map = {
                'high_risk': getattr(app_policy, 'general_input_high_risk_action', None)
                    or getattr(tenant_policy, 'default_general_input_high_risk_action', None)
                    or getattr(tenant_policy, 'default_general_high_risk_action', 'block') or 'block',
                'medium_risk': getattr(app_policy, 'general_input_medium_risk_action', None)
                    or getattr(tenant_policy, 'default_general_input_medium_risk_action', None)
                    or getattr(tenant_policy, 'default_general_medium_risk_action', 'replace') or 'replace',
                'low_risk': getattr(app_policy, 'general_input_low_risk_action', None)
                    or getattr(tenant_policy, 'default_general_input_low_risk_action', None)
                    or getattr(tenant_policy, 'default_general_low_risk_action', 'pass') or 'pass',
            }
        else:
            action_map = {
                'high_risk': getattr(app_policy, 'general_output_high_risk_action', None)
                    or getattr(tenant_policy, 'default_general_output_high_risk_action', None)
                    or getattr(tenant_policy, 'default_general_high_risk_action', 'block') or 'block',
                'medium_risk': getattr(app_policy, 'general_output_medium_risk_action', None)
                    or getattr(tenant_policy, 'default_general_output_medium_risk_action', None)
                    or getattr(tenant_policy, 'default_general_medium_risk_action', 'replace') or 'replace',
                'low_risk': getattr(app_policy, 'general_output_low_risk_action', None)
                    or getattr(tenant_policy, 'default_general_output_low_risk_action', None)
                    or getattr(tenant_policy, 'default_general_low_risk_action', 'pass') or 'pass',
            }
        action = action_map.get(risk_level, 'pass')
        logger.debug(f"General {direction} risk action for {risk_level}: {action}")
        return action

    async def get_private_model(
        self,
        application_id: str,
        tenant_id: str,
    ) -> Optional[UpstreamApiConfig]:
        """Pick the private model to switch to. Priority: app override →
        tenant default → first-active fallback."""
        try:
            app_policy = await self.get_disposal_policy(application_id)

            # 1. App override.
            if app_policy and app_policy.private_model_id:
                res = await self.db.execute(
                    select(UpstreamApiConfig).where(
                        and_(
                            UpstreamApiConfig.id == app_policy.private_model_id,
                            UpstreamApiConfig.is_private_model == True,  # noqa: E712
                            UpstreamApiConfig.is_active == True,  # noqa: E712
                        )
                    )
                )
                private_model = res.scalar_one_or_none()
                if private_model:
                    logger.info(f"Using application-configured private model: {private_model.config_name}")
                    return private_model
                logger.warning(f"Application's configured private model {app_policy.private_model_id} not found or inactive")

            # 2. Tenant default.
            res = await self.db.execute(
                select(UpstreamApiConfig).where(
                    and_(
                        UpstreamApiConfig.tenant_id == tenant_id,
                        UpstreamApiConfig.is_private_model == True,  # noqa: E712
                        UpstreamApiConfig.is_default_private_model == True,  # noqa: E712
                        UpstreamApiConfig.is_active == True,  # noqa: E712
                    )
                )
            )
            default_private_model = res.scalar_one_or_none()
            if default_private_model:
                logger.info(f"Using tenant's default private model: {default_private_model.config_name}")
                return default_private_model

            # 3. Fallback: first active.
            res = await self.db.execute(
                select(UpstreamApiConfig)
                .where(
                    and_(
                        UpstreamApiConfig.tenant_id == tenant_id,
                        UpstreamApiConfig.is_private_model == True,  # noqa: E712
                        UpstreamApiConfig.is_active == True,  # noqa: E712
                    )
                )
                .order_by(UpstreamApiConfig.created_at.asc())
                .limit(1)
            )
            fallback_private_model = res.scalar_one_or_none()
            if fallback_private_model:
                logger.info(f"Using first available private model: {fallback_private_model.config_name}")
                return fallback_private_model

            logger.warning(f"No private model found for tenant {tenant_id}")
            return None

        except Exception as e:
            logger.error(f"Error getting private model: {e}", exc_info=True)
            return None
