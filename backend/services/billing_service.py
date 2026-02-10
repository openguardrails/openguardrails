"""
Billing Service - Manages tenant subscriptions and monthly quota limits
"""

import time
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional, Tuple
from sqlalchemy.orm import Session
from sqlalchemy import text, func, and_
from uuid import UUID
from database.models import TenantSubscription, DetectionResult, Tenant
from utils.logger import setup_logger
from config import settings

logger = setup_logger()


def get_current_utc_time() -> datetime:
    """Get current UTC time with timezone info"""
    return datetime.now(timezone.utc)


class BillingService:
    """Tenant billing and subscription management service"""

    # Subscription type configurations loaded from settings
    # This will be initialized when the class is defined
    SUBSCRIPTION_CONFIGS: Dict = {}

    def __init__(self):
        # Cache for tenant subscriptions {tenant_id: (subscription, cached_time)}
        self._subscription_cache: Dict[str, Tuple[TenantSubscription, float]] = {}
        self._cache_ttl = 60  # 60 seconds cache TTL
        # Cache for subscription tiers
        self._tier_cache: Dict = {}
        self._tier_cache_time: float = 0
        self._tier_cache_ttl: int = 300  # 5 minutes

    def _check_and_handle_expiry(self, subscription: TenantSubscription, db: Session) -> bool:
        """
        Check if subscription has expired and auto-downgrade if so.

        Returns:
            True if subscription was expired and downgraded, False otherwise
        """
        if subscription.subscription_type != 'subscribed':
            return False
        if subscription.subscription_expires_at is None:
            return False

        current_time = get_current_utc_time()
        if current_time <= subscription.subscription_expires_at:
            return False

        # Subscription has expired - downgrade to free
        tenant_id = str(subscription.tenant_id)
        old_quota = subscription.monthly_quota
        free_config = self.SUBSCRIPTION_CONFIGS.get('free', {})
        free_quota = free_config.get('monthly_quota', 1000)

        subscription.subscription_type = 'free'
        subscription.monthly_quota = free_quota
        if hasattr(subscription, 'subscription_tier'):
            subscription.subscription_tier = 0
        subscription.updated_at = current_time

        try:
            db.commit()
            # Clear cache
            self._subscription_cache.pop(tenant_id, None)
            logger.warning(
                f"Subscription expired for tenant {tenant_id}: "
                f"auto-downgraded to free (quota {old_quota} -> {free_quota})"
            )
            return True
        except Exception as e:
            db.rollback()
            logger.error(f"Failed to downgrade expired subscription for tenant {tenant_id}: {e}")
            return False

    def get_subscription(self, tenant_id: str, db: Session) -> Optional[TenantSubscription]:
        """Get tenant subscription with caching"""
        try:
            # Check if tenant is super admin - they get automatic 'subscribed' access
            tenant_uuid = UUID(tenant_id)
            tenant = db.query(Tenant).filter(Tenant.id == tenant_uuid).first()
            
            if tenant and hasattr(tenant, 'is_super_admin') and tenant.is_super_admin:
                # Create a virtual subscription for super admin (not saved to DB)
                virtual_subscription = TenantSubscription(
                    id=tenant_uuid,
                    tenant_id=tenant_uuid,
                    subscription_type='subscribed',
                    monthly_quota=999999999,  # Unlimited quota for super admin
                    current_month_usage=0,
                    usage_reset_at=datetime(2099, 12, 31, tzinfo=timezone.utc)
                )
                logger.debug(f"Super admin {tenant.email} granted automatic subscription access")
                return virtual_subscription
            
            # Check cache
            cache_entry = self._subscription_cache.get(tenant_id)
            current_time = time.time()

            if cache_entry:
                subscription, cached_time = cache_entry
                if current_time - cached_time < self._cache_ttl:
                    return subscription

            # Query from database
            subscription = db.query(TenantSubscription).filter(
                TenantSubscription.tenant_id == tenant_uuid
            ).first()

            if subscription:
                # Check and handle expiry before caching
                self._check_and_handle_expiry(subscription, db)
                # Update cache
                self._subscription_cache[tenant_id] = (subscription, current_time)

            return subscription

        except Exception as e:
            logger.error(f"Failed to get subscription for tenant {tenant_id}: {e}")
            return None

    def check_and_increment_usage(self, tenant_id: str, db: Session) -> Tuple[bool, Optional[str]]:
        """
        Check if tenant has quota available and increment usage

        Returns:
            (is_allowed, error_message)
        """
        try:
            tenant_uuid = UUID(tenant_id)
            current_time = get_current_utc_time()

            # Check if tenant is super admin - they have unlimited quota
            tenant = db.query(Tenant).filter(Tenant.id == tenant_uuid).first()
            if tenant and hasattr(tenant, 'is_super_admin') and tenant.is_super_admin:
                logger.debug(f"Super admin {tenant.email} bypassed quota check (unlimited access)")
                return True, None

            # First, get the subscription to check if reset is needed
            subscription = db.query(TenantSubscription).filter(
                TenantSubscription.tenant_id == tenant_uuid
            ).first()

            # Auto-create subscription if it doesn't exist (for legacy users)
            if not subscription:
                logger.warning(f"Subscription not found for tenant {tenant_id}, creating default subscription")
                try:
                    subscription = self.create_subscription(tenant_id, 'free', db)
                except Exception as create_error:
                    logger.error(f"Failed to auto-create subscription for tenant {tenant_id}: {create_error}")
                    return False, "Subscription not found. Please contact support."

            # Check and handle subscription expiry
            self._check_and_handle_expiry(subscription, db)

            # Check if we need to reset the quota (BEFORE checking quota availability)
            needs_reset = current_time >= subscription.usage_reset_at

            if needs_reset:
                # Calculate next reset date based on subscription creation date
                next_reset = self._calculate_next_reset_date(current_time, subscription.created_at)

                # Reset usage and update reset date
                subscription.current_month_usage = 0  # Reset to 0 first
                subscription.usage_reset_at = next_reset
                subscription.updated_at = current_time

                db.commit()

                # Clear cache
                self._subscription_cache.pop(tenant_id, None)

                logger.info(f"Quota reset for tenant {tenant_id}, next reset: {next_reset}")

                # After reset, continue to check quota availability for this request

            # Check purchased quota first (pay-per-use, consumed before monthly quota)
            if subscription.purchased_quota > 0:
                if subscription.purchased_quota_expires_at and current_time > subscription.purchased_quota_expires_at:
                    # Purchased quota expired - reset to 0
                    subscription.purchased_quota = 0
                    subscription.purchased_quota_expires_at = None
                    subscription.updated_at = current_time
                    db.commit()
                    self._subscription_cache.pop(tenant_id, None)
                    logger.info(f"Purchased quota expired for tenant {tenant_id}, reset to 0")
                else:
                    # Decrement purchased quota
                    subscription.purchased_quota -= 1
                    subscription.updated_at = current_time
                    db.commit()
                    self._subscription_cache.pop(tenant_id, None)
                    logger.debug(f"Used purchased quota for tenant {tenant_id}: {subscription.purchased_quota} remaining")
                    return True, None

            # Check if quota is available (AFTER potential reset)
            if subscription.current_month_usage >= subscription.monthly_quota:
                reset_date = subscription.usage_reset_at.strftime('%Y-%m-%d')
                error_msg = (
                    f"Monthly quota exceeded. "
                    f"Current usage: {subscription.current_month_usage}/{subscription.monthly_quota}. "
                    f"Quota resets on {reset_date}."
                )
                logger.warning(f"Quota exceeded for tenant {tenant_id}: {subscription.current_month_usage}/{subscription.monthly_quota}")
                return False, error_msg

            # Increment usage
            subscription.current_month_usage += 1
            subscription.updated_at = current_time
            db.commit()

            # Clear cache
            self._subscription_cache.pop(tenant_id, None)

            logger.debug(f"Billing check passed for tenant {tenant_id}: {subscription.current_month_usage}/{subscription.monthly_quota}")
            return True, None

        except Exception as e:
            logger.error(f"Billing check failed for tenant {tenant_id}: {e}")
            db.rollback()
            # Allow through on error to avoid service disruption
            return True, None

    def get_subscription_with_usage(self, tenant_id: str, db: Session) -> Optional[dict]:
        """Get subscription info with current usage and percentage"""
        try:
            tenant_uuid = UUID(tenant_id)
            subscription = db.query(TenantSubscription).filter(
                TenantSubscription.tenant_id == tenant_uuid
            ).first()

            # Auto-create subscription if it doesn't exist (for legacy users)
            if not subscription:
                logger.warning(f"Subscription not found for tenant {tenant_id}, creating default subscription")
                subscription = self.create_subscription(tenant_id, 'free', db)
                if not subscription:
                    return None

            # Check and handle subscription expiry
            self._check_and_handle_expiry(subscription, db)

            # Check if reset is needed
            current_time = get_current_utc_time()
            if current_time >= subscription.usage_reset_at:
                subscription.current_month_usage = 0
                # Calculate next reset based on subscription creation date
                subscription.usage_reset_at = self._calculate_next_reset_date(current_time, subscription.created_at)
                db.commit()

            usage_percentage = (subscription.current_month_usage / subscription.monthly_quota * 100) if subscription.monthly_quota > 0 else 0

            # Calculate billing period start based on usage_reset_at (period_start = previous reset date)
            period_end = subscription.usage_reset_at
            # Period start is approximately one month before period_end
            if period_end.month == 1:
                period_start = period_end.replace(year=period_end.year - 1, month=12)
            else:
                try:
                    period_start = period_end.replace(month=period_end.month - 1)
                except ValueError:
                    # Handle months with different day counts
                    period_start = period_end.replace(month=period_end.month - 1, day=28)

            # Query usage breakdown for current billing period
            usage_breakdown = {'guardrails_proxy': 0, 'direct_model_access': 0}
            try:
                dma_count = db.query(func.count(DetectionResult.id)).filter(
                    and_(
                        DetectionResult.tenant_id == tenant_uuid,
                        DetectionResult.is_direct_model_access == True,
                        DetectionResult.created_at >= period_start,
                        DetectionResult.created_at < period_end
                    )
                ).scalar() or 0

                total_count = db.query(func.count(DetectionResult.id)).filter(
                    and_(
                        DetectionResult.tenant_id == tenant_uuid,
                        DetectionResult.created_at >= period_start,
                        DetectionResult.created_at < period_end
                    )
                ).scalar() or 0

                usage_breakdown = {
                    'guardrails_proxy': total_count - dma_count,
                    'direct_model_access': dma_count
                }
            except Exception as breakdown_err:
                logger.warning(f"Failed to get usage breakdown for tenant {tenant_id}: {breakdown_err}")

            # Get tier info
            subscription_tier = getattr(subscription, 'subscription_tier', 0) or 0

            # Get purchased quota info
            purchased_quota = getattr(subscription, 'purchased_quota', 0) or 0
            purchased_quota_expires_at = getattr(subscription, 'purchased_quota_expires_at', None)

            # Check if purchased quota is expired
            if purchased_quota > 0 and purchased_quota_expires_at and current_time > purchased_quota_expires_at:
                purchased_quota = 0
                purchased_quota_expires_at = None

            return {
                'id': str(subscription.id),
                'tenant_id': str(subscription.tenant_id),
                'subscription_type': subscription.subscription_type,
                'subscription_tier': subscription_tier,
                'monthly_quota': subscription.monthly_quota,
                'current_month_usage': subscription.current_month_usage,
                'usage_reset_at': subscription.usage_reset_at.isoformat(),
                'usage_percentage': round(usage_percentage, 2),
                'plan_name': self.SUBSCRIPTION_CONFIGS.get(subscription.subscription_type, {}).get('name', 'Unknown'),
                'usage_breakdown': usage_breakdown,
                'billing_period_start': period_start.isoformat(),
                'billing_period_end': period_end.isoformat(),
                'purchased_quota': purchased_quota,
                'purchased_quota_expires_at': purchased_quota_expires_at.isoformat() if purchased_quota_expires_at else None
            }

        except Exception as e:
            logger.error(f"Failed to get subscription info for tenant {tenant_id}: {e}")
            return None

    def create_subscription(self, tenant_id: str, subscription_type: str, db: Session) -> TenantSubscription:
        """Create new subscription for tenant"""
        try:
            tenant_uuid = UUID(tenant_id)

            # Check if subscription already exists
            existing = db.query(TenantSubscription).filter(
                TenantSubscription.tenant_id == tenant_uuid
            ).first()

            if existing:
                raise ValueError(f"Subscription already exists for tenant {tenant_id}")

            # Validate subscription type
            if subscription_type not in self.SUBSCRIPTION_CONFIGS:
                raise ValueError(f"Invalid subscription type: {subscription_type}")

            config = self.SUBSCRIPTION_CONFIGS[subscription_type]
            current_time = get_current_utc_time()
            reset_date = self._calculate_next_reset_date(current_time)

            subscription = TenantSubscription(
                tenant_id=tenant_uuid,
                subscription_type=subscription_type,
                monthly_quota=config['monthly_quota'],
                current_month_usage=0,
                usage_reset_at=reset_date
            )

            db.add(subscription)
            db.commit()
            db.refresh(subscription)

            logger.info(f"Created {subscription_type} subscription for tenant {tenant_id}")
            return subscription

        except Exception as e:
            db.rollback()
            logger.error(f"Failed to create subscription for tenant {tenant_id}: {e}")
            raise

    def update_subscription_type(self, tenant_id: str, new_subscription_type: str, db: Session) -> TenantSubscription:
        """Update tenant subscription type (upgrade/downgrade)"""
        try:
            tenant_uuid = UUID(tenant_id)

            # Validate subscription type
            if new_subscription_type not in self.SUBSCRIPTION_CONFIGS:
                raise ValueError(f"Invalid subscription type: {new_subscription_type}")

            subscription = db.query(TenantSubscription).filter(
                TenantSubscription.tenant_id == tenant_uuid
            ).first()

            if not subscription:
                raise ValueError(f"Subscription not found for tenant {tenant_id}")

            old_type = subscription.subscription_type
            config = self.SUBSCRIPTION_CONFIGS[new_subscription_type]

            subscription.subscription_type = new_subscription_type
            subscription.monthly_quota = config['monthly_quota']
            subscription.updated_at = get_current_utc_time()

            # If downgrading and usage exceeds new quota, cap usage at new quota
            if subscription.current_month_usage > subscription.monthly_quota:
                logger.warning(
                    f"Tenant {tenant_id} usage ({subscription.current_month_usage}) "
                    f"exceeds new quota ({subscription.monthly_quota}) after downgrade"
                )
                # Don't modify usage - they'll be blocked until next reset

            db.commit()
            db.refresh(subscription)

            # Clear cache
            self._subscription_cache.pop(tenant_id, None)

            logger.info(f"Updated tenant {tenant_id} subscription: {old_type} -> {new_subscription_type}")
            return subscription

        except Exception as e:
            db.rollback()
            logger.error(f"Failed to update subscription for tenant {tenant_id}: {e}")
            raise

    def reset_monthly_quota(self, tenant_id: str, db: Session) -> TenantSubscription:
        """Manually reset monthly quota for a tenant (admin function)"""
        try:
            tenant_uuid = UUID(tenant_id)
            current_time = get_current_utc_time()

            subscription = db.query(TenantSubscription).filter(
                TenantSubscription.tenant_id == tenant_uuid
            ).first()

            if not subscription:
                raise ValueError(f"Subscription not found for tenant {tenant_id}")

            subscription.current_month_usage = 0
            # Calculate next reset based on subscription creation date
            subscription.usage_reset_at = self._calculate_next_reset_date(current_time, subscription.created_at)
            subscription.updated_at = current_time

            db.commit()
            db.refresh(subscription)

            # Clear cache
            self._subscription_cache.pop(tenant_id, None)

            logger.info(f"Manually reset quota for tenant {tenant_id}")
            return subscription

        except Exception as e:
            db.rollback()
            logger.error(f"Failed to reset quota for tenant {tenant_id}: {e}")
            raise

    def reset_all_quotas(self, db: Session) -> int:
        """Reset quotas for all tenants (scheduled task for 1st of each month)"""
        try:
            current_time = get_current_utc_time()
            next_reset = self._calculate_next_reset_date(current_time)

            result = db.execute(text("""
                UPDATE tenant_subscriptions
                SET
                    current_month_usage = 0,
                    usage_reset_at = :next_reset,
                    updated_at = :current_time
                WHERE usage_reset_at <= :current_time
                RETURNING tenant_id
            """), {
                "next_reset": next_reset,
                "current_time": current_time
            })

            reset_count = len(result.fetchall())
            db.commit()

            # Clear all cache
            self._subscription_cache.clear()

            logger.info(f"Reset quotas for {reset_count} tenants")
            return reset_count

        except Exception as e:
            db.rollback()
            logger.error(f"Failed to reset all quotas: {e}")
            raise

    def list_subscriptions(self, db: Session, skip: int = 0, limit: int = 100,
                          search: str = None, subscription_type: str = None,
                          sort_by: str = 'current_month_usage', sort_order: str = 'desc'):
        """List all tenant subscriptions with pagination and filters
        
        Args:
            sort_by: Field to sort by ('current_month_usage' or 'usage_reset_at')
            sort_order: Sort order ('asc' or 'desc')
        """
        try:
            query = db.query(TenantSubscription).join(
                Tenant, TenantSubscription.tenant_id == Tenant.id
            )

            # Apply filters
            if search:
                query = query.filter(Tenant.email.ilike(f'%{search}%'))

            if subscription_type and subscription_type in self.SUBSCRIPTION_CONFIGS:
                query = query.filter(TenantSubscription.subscription_type == subscription_type)

            # Apply sorting
            if sort_by == 'current_month_usage':
                if sort_order.lower() == 'asc':
                    query = query.order_by(TenantSubscription.current_month_usage.asc())
                else:
                    query = query.order_by(TenantSubscription.current_month_usage.desc())
            elif sort_by == 'usage_reset_at':
                if sort_order.lower() == 'asc':
                    query = query.order_by(TenantSubscription.usage_reset_at.asc())
                else:
                    query = query.order_by(TenantSubscription.usage_reset_at.desc())
            else:
                # Default: sort by usage descending
                query = query.order_by(TenantSubscription.current_month_usage.desc())

            # Get total count
            total = query.count()

            # Apply pagination
            subscriptions = query.offset(skip).limit(limit).all()

            # Build response
            results = []
            for sub in subscriptions:
                usage_percentage = (sub.current_month_usage / sub.monthly_quota * 100) if sub.monthly_quota > 0 else 0
                results.append({
                    'id': str(sub.id),
                    'tenant_id': str(sub.tenant_id),
                    'email': sub.tenant.email,
                    'subscription_type': sub.subscription_type,
                    'monthly_quota': sub.monthly_quota,
                    'current_month_usage': sub.current_month_usage,
                    'usage_reset_at': sub.usage_reset_at.isoformat(),
                    'usage_percentage': round(usage_percentage, 2),
                    'plan_name': self.SUBSCRIPTION_CONFIGS.get(sub.subscription_type, {}).get('name', 'Unknown')
                })

            return results, total

        except Exception as e:
            logger.error(f"Failed to list subscriptions: {e}")
            raise

    # =====================================================
    # Tier Management
    # =====================================================

    def _load_stripe_price_ids_from_env(self) -> Dict[int, str]:
        """Load Stripe price ID mapping from STRIPE_PRICE_IDS env var (JSON string)"""
        import json
        raw = settings.stripe_price_ids
        if not raw:
            return {}
        try:
            mapping = json.loads(raw)
            # Keys may be strings like "1", "2" - convert to int
            return {int(k): v for k, v in mapping.items() if v}
        except Exception as e:
            logger.warning(f"Failed to parse STRIPE_PRICE_IDS env var: {e}")
            return {}

    def get_all_tiers(self, db: Session) -> list:
        """Get all active subscription tiers with caching"""
        from database.models import SubscriptionTier

        current_time = time.time()
        if self._tier_cache and (current_time - self._tier_cache_time < self._tier_cache_ttl):
            return list(self._tier_cache.values())

        tiers = db.query(SubscriptionTier).filter(
            SubscriptionTier.is_active == True
        ).order_by(SubscriptionTier.display_order).all()

        # Load Stripe price IDs from env var (sole source for Stripe price IDs)
        env_price_ids = self._load_stripe_price_ids_from_env()

        self._tier_cache = {}
        for tier in tiers:
            self._tier_cache[tier.tier_number] = {
                'tier_number': tier.tier_number,
                'tier_name': tier.tier_name,
                'monthly_quota': tier.monthly_quota,
                'price_usd': float(tier.price_usd),
                'price_cny': float(tier.price_cny),
                'stripe_price_id': env_price_ids.get(tier.tier_number),
                'display_order': tier.display_order
            }
        self._tier_cache_time = current_time

        return list(self._tier_cache.values())

    def get_tier_config(self, tier_number: int, db: Session) -> Optional[dict]:
        """Get configuration for a specific tier"""
        # Ensure cache is populated
        self.get_all_tiers(db)
        return self._tier_cache.get(tier_number)

    def update_subscription_tier(self, tenant_id: str, tier_number: int, db: Session) -> TenantSubscription:
        """Update tenant subscription to a specific tier"""
        try:
            tenant_uuid = UUID(tenant_id)
            tier_config = self.get_tier_config(tier_number, db)

            if not tier_config:
                raise ValueError(f"Invalid tier number: {tier_number}")

            subscription = db.query(TenantSubscription).filter(
                TenantSubscription.tenant_id == tenant_uuid
            ).first()

            if not subscription:
                raise ValueError(f"Subscription not found for tenant {tenant_id}")

            old_tier = getattr(subscription, 'subscription_tier', 0) or 0
            subscription.subscription_type = 'subscribed'
            subscription.subscription_tier = tier_number
            subscription.monthly_quota = tier_config['monthly_quota']
            subscription.updated_at = get_current_utc_time()

            db.commit()
            db.refresh(subscription)

            # Clear cache
            self._subscription_cache.pop(tenant_id, None)

            logger.info(
                f"Updated tenant {tenant_id} subscription tier: "
                f"{old_tier} -> {tier_number} ({tier_config['tier_name']}, quota={tier_config['monthly_quota']})"
            )
            return subscription

        except Exception as e:
            db.rollback()
            logger.error(f"Failed to update subscription tier for tenant {tenant_id}: {e}")
            raise

    def add_purchased_quota(self, tenant_id: str, units: int, db: Session) -> TenantSubscription:
        """
        Add purchased quota to tenant subscription (pay-per-use).
        If existing quota is expired, resets to 0 before adding.
        Each purchase extends expiry to 1 year from now.
        """
        try:
            tenant_uuid = UUID(tenant_id)
            current_time = get_current_utc_time()

            subscription = db.query(TenantSubscription).filter(
                TenantSubscription.tenant_id == tenant_uuid
            ).first()

            if not subscription:
                raise ValueError(f"Subscription not found for tenant {tenant_id}")

            # If existing quota is expired, reset to 0
            if (subscription.purchased_quota_expires_at and
                    current_time > subscription.purchased_quota_expires_at):
                subscription.purchased_quota = 0

            # Add new quota
            calls_to_add = units * settings.quota_calls_per_unit
            subscription.purchased_quota = (subscription.purchased_quota or 0) + calls_to_add
            subscription.purchased_quota_expires_at = current_time + timedelta(days=settings.quota_validity_days)
            subscription.updated_at = current_time

            db.commit()
            db.refresh(subscription)

            # Clear cache
            self._subscription_cache.pop(tenant_id, None)

            logger.info(
                f"Added {calls_to_add} purchased quota for tenant {tenant_id} "
                f"({units} units). Total: {subscription.purchased_quota}, "
                f"expires: {subscription.purchased_quota_expires_at}"
            )
            return subscription

        except Exception as e:
            db.rollback()
            logger.error(f"Failed to add purchased quota for tenant {tenant_id}: {e}")
            raise

    def _calculate_next_reset_date(self, current_time: datetime, from_date: datetime = None) -> datetime:
        """
        Calculate the next quota reset date based on subscription start date

        For example:
        - If subscription started on 2025-01-15, reset dates will be: 2025-02-15, 2025-03-15, etc.
        - This ensures each tenant has a full month from their subscription start
        """
        if from_date is None:
            from_date = current_time

        # Get the day of month from subscription start
        reset_day = from_date.day

        # Calculate next reset based on current time
        year = current_time.year
        month = current_time.month

        # Try to create the reset date in the current month
        try:
            next_reset = datetime(year, month, reset_day, 0, 0, 0, tzinfo=timezone.utc)
            # If that date has already passed, move to next month
            if next_reset <= current_time:
                if month == 12:
                    month = 1
                    year += 1
                else:
                    month += 1

                # Handle months with fewer days (e.g., Feb 30 -> Feb 28/29)
                while True:
                    try:
                        next_reset = datetime(year, month, reset_day, 0, 0, 0, tzinfo=timezone.utc)
                        break
                    except ValueError:
                        # Day doesn't exist in this month, use last day of month
                        if month == 2:
                            # February - check for leap year
                            if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0):
                                reset_day = 29
                            else:
                                reset_day = 28
                        elif month in [4, 6, 9, 11]:
                            reset_day = 30
                        else:
                            reset_day = 31
        except ValueError:
            # Handle edge case where reset_day is invalid for current month
            # Use last day of current month
            if month == 12:
                month = 1
                year += 1
            else:
                month += 1
            next_reset = datetime(year, month, 1, 0, 0, 0, tzinfo=timezone.utc)

        return next_reset

    def clear_cache(self, tenant_id: str = None):
        """Clear subscription cache for specific tenant or all tenants"""
        if tenant_id:
            self._subscription_cache.pop(tenant_id, None)
            logger.debug(f"Cleared billing cache for tenant {tenant_id}")
        else:
            self._subscription_cache.clear()
            logger.debug("Cleared all billing cache")


# Initialize SUBSCRIPTION_CONFIGS from settings
BillingService.SUBSCRIPTION_CONFIGS = {
    'free': {
        'monthly_quota': settings.free_user_monthly_quota,
        'name': 'Free Plan'
    },
    'subscribed': {
        'monthly_quota': settings.paid_user_monthly_quota,
        'name': 'Subscribed Plan'
    }
}

# Global billing service instance
billing_service = BillingService()
