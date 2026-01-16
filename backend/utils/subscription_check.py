"""
Subscription Check Utilities

Provides helper functions to check subscription status for premium features.
Supports enterprise mode bypass (all features enabled for private deployments).
"""

from typing import Tuple, Optional
from uuid import UUID
from sqlalchemy.orm import Session
from fastapi import HTTPException, status

from config import settings
from database.models import TenantSubscription, Tenant
from utils.logger import setup_logger

logger = setup_logger()


class SubscriptionFeature:
    """Premium feature identifiers"""
    GENAI_RECOGNITION = "genai_recognition"  # GenAI entity recognition
    GENAI_CODE_ANONYMIZATION = "genai_code_anonymization"  # GenAI code-based anonymization
    NATURAL_LANGUAGE_DESC = "natural_language_desc"  # Natural language description for anonymization
    FORMAT_DETECTION = "format_detection"  # Auto format detection
    SMART_SEGMENTATION = "smart_segmentation"  # Smart content segmentation
    CUSTOM_SCANNERS = "custom_scanners"  # Custom scanner creation


# Feature descriptions for error messages (Chinese and English)
FEATURE_DESCRIPTIONS = {
    SubscriptionFeature.GENAI_RECOGNITION: {
        "en": "GenAI entity recognition",
        "zh": "AI 智能识别"
    },
    SubscriptionFeature.GENAI_CODE_ANONYMIZATION: {
        "en": "GenAI code-based anonymization",
        "zh": "AI 代码脱敏"
    },
    SubscriptionFeature.NATURAL_LANGUAGE_DESC: {
        "en": "Natural language anonymization description",
        "zh": "自然语言脱敏描述"
    },
    SubscriptionFeature.FORMAT_DETECTION: {
        "en": "Auto format detection",
        "zh": "自动格式检测"
    },
    SubscriptionFeature.SMART_SEGMENTATION: {
        "en": "Smart content segmentation",
        "zh": "智能内容分段"
    },
    SubscriptionFeature.CUSTOM_SCANNERS: {
        "en": "Custom scanners",
        "zh": "自定义扫描器"
    }
}


def is_enterprise_mode() -> bool:
    """Check if running in enterprise mode (private deployment)"""
    return settings.is_enterprise_mode


def check_subscription_for_feature(
    tenant_id: str,
    db: Session,
    feature: str,
    language: str = "en"
) -> Tuple[bool, Optional[str]]:
    """
    Check if tenant has subscription access for a premium feature.

    In enterprise mode, all features are enabled regardless of subscription.
    In SaaS mode, requires 'subscribed' subscription type.

    Args:
        tenant_id: The tenant's UUID string
        db: Database session
        feature: Feature identifier from SubscriptionFeature class
        language: Language for error message ('en' or 'zh')

    Returns:
        Tuple of (is_allowed: bool, error_message: Optional[str])
        - (True, None) if allowed
        - (False, error_message) if not allowed
    """
    # Enterprise mode: all features enabled
    if is_enterprise_mode():
        logger.debug(f"Enterprise mode: feature '{feature}' enabled for all users")
        return True, None

    try:
        tenant_uuid = UUID(tenant_id)

        # Check if tenant is super admin
        tenant = db.query(Tenant).filter(Tenant.id == tenant_uuid).first()
        if tenant and hasattr(tenant, 'is_super_admin') and tenant.is_super_admin:
            logger.debug(f"Super admin {tenant.email} granted access to feature '{feature}'")
            return True, None

        # Check subscription status
        subscription = db.query(TenantSubscription).filter(
            TenantSubscription.tenant_id == tenant_uuid
        ).first()

        # If no subscription or not subscribed, deny access
        if not subscription or subscription.subscription_type != 'subscribed':
            feature_desc = FEATURE_DESCRIPTIONS.get(feature, {}).get(language, feature)

            if language == "zh":
                error_msg = f"「{feature_desc}」是高级功能，请升级到订阅计划后使用。"
            else:
                error_msg = f"'{feature_desc}' is a premium feature. Please upgrade to a subscribed plan to access this feature."

            logger.info(f"Feature '{feature}' denied for tenant {tenant_id}: not subscribed")
            return False, error_msg

        logger.debug(f"Subscription check passed for tenant {tenant_id}, feature '{feature}'")
        return True, None

    except Exception as e:
        logger.error(f"Subscription check failed for tenant {tenant_id}: {e}")
        # Allow through on error to avoid service disruption
        return True, None


def require_subscription_for_feature(
    tenant_id: str,
    db: Session,
    feature: str,
    language: str = "en"
) -> None:
    """
    Require subscription for a premium feature, raising HTTPException if not allowed.

    Args:
        tenant_id: The tenant's UUID string
        db: Database session
        feature: Feature identifier from SubscriptionFeature class
        language: Language for error message ('en' or 'zh')

    Raises:
        HTTPException: 403 Forbidden if subscription check fails
    """
    is_allowed, error_msg = check_subscription_for_feature(
        tenant_id=tenant_id,
        db=db,
        feature=feature,
        language=language
    )

    if not is_allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=error_msg
        )


def get_feature_availability(
    tenant_id: str,
    db: Session
) -> dict:
    """
    Get availability status for all premium features.

    Returns a dict with feature names as keys and availability status.
    Useful for frontend to show/hide premium features.

    Args:
        tenant_id: The tenant's UUID string
        db: Database session

    Returns:
        Dict with feature availability status:
        {
            "is_enterprise": bool,
            "is_subscribed": bool,
            "features": {
                "genai_recognition": bool,
                "genai_code_anonymization": bool,
                ...
            }
        }
    """
    result = {
        "is_enterprise": is_enterprise_mode(),
        "is_subscribed": False,
        "features": {}
    }

    # Enterprise mode: all features enabled
    if is_enterprise_mode():
        result["is_subscribed"] = True
        for feature in [
            SubscriptionFeature.GENAI_RECOGNITION,
            SubscriptionFeature.GENAI_CODE_ANONYMIZATION,
            SubscriptionFeature.NATURAL_LANGUAGE_DESC,
            SubscriptionFeature.FORMAT_DETECTION,
            SubscriptionFeature.SMART_SEGMENTATION,
            SubscriptionFeature.CUSTOM_SCANNERS
        ]:
            result["features"][feature] = True
        return result

    try:
        tenant_uuid = UUID(tenant_id)

        # Check if super admin
        tenant = db.query(Tenant).filter(Tenant.id == tenant_uuid).first()
        is_super_admin = tenant and hasattr(tenant, 'is_super_admin') and tenant.is_super_admin

        # Check subscription
        subscription = db.query(TenantSubscription).filter(
            TenantSubscription.tenant_id == tenant_uuid
        ).first()

        is_subscribed = (
            is_super_admin or
            (subscription and subscription.subscription_type == 'subscribed')
        )

        result["is_subscribed"] = is_subscribed

        for feature in [
            SubscriptionFeature.GENAI_RECOGNITION,
            SubscriptionFeature.GENAI_CODE_ANONYMIZATION,
            SubscriptionFeature.NATURAL_LANGUAGE_DESC,
            SubscriptionFeature.FORMAT_DETECTION,
            SubscriptionFeature.SMART_SEGMENTATION,
            SubscriptionFeature.CUSTOM_SCANNERS
        ]:
            result["features"][feature] = is_subscribed

        return result

    except Exception as e:
        logger.error(f"Failed to get feature availability for tenant {tenant_id}: {e}")
        # Return all enabled on error
        for feature in [
            SubscriptionFeature.GENAI_RECOGNITION,
            SubscriptionFeature.GENAI_CODE_ANONYMIZATION,
            SubscriptionFeature.NATURAL_LANGUAGE_DESC,
            SubscriptionFeature.FORMAT_DETECTION,
            SubscriptionFeature.SMART_SEGMENTATION,
            SubscriptionFeature.CUSTOM_SCANNERS
        ]:
            result["features"][feature] = True
        return result
