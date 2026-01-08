"""
Billing Service - Manages tenant subscriptions and monthly quota limits
"""

import time
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional, Tuple
from sqlalchemy.orm import Session
from sqlalchemy import text, func
from uuid import UUID
from database.models import TenantSubscription, DetectionResult, Tenant
from utils.logger import setup_logger

logger = setup_logger()


def get_current_utc_time() -> datetime:
    """Get current UTC time with timezone info"""
    return datetime.now(timezone.utc)


class BillingService:
    """Tenant billing and subscription management service"""

    # Subscription type configurations
    SUBSCRIPTION_CONFIGS = {
        'free': {
            'monthly_quota': 1000,
            'name': 'Free Plan'
        },
        'subscribed': {
            'monthly_quota': 100000,
            'name': 'Subscribed Plan'
        }
    }

    def __init__(self):
        # Cache for tenant subscriptions {tenant_id: (subscription, cached_time)}
        self._subscription_cache: Dict[str, Tuple[TenantSubscription, float]] = {}
        self._cache_ttl = 60  # 60 seconds cache TTL

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

            # Check if reset is needed
            current_time = get_current_utc_time()
            if current_time >= subscription.usage_reset_at:
                subscription.current_month_usage = 0
                # Calculate next reset based on subscription creation date
                subscription.usage_reset_at = self._calculate_next_reset_date(current_time, subscription.created_at)
                db.commit()

            usage_percentage = (subscription.current_month_usage / subscription.monthly_quota * 100) if subscription.monthly_quota > 0 else 0

            return {
                'id': str(subscription.id),
                'tenant_id': str(subscription.tenant_id),
                'subscription_type': subscription.subscription_type,
                'monthly_quota': subscription.monthly_quota,
                'current_month_usage': subscription.current_month_usage,
                'usage_reset_at': subscription.usage_reset_at.isoformat(),
                'usage_percentage': round(usage_percentage, 2),
                'plan_name': self.SUBSCRIPTION_CONFIGS.get(subscription.subscription_type, {}).get('name', 'Unknown')
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


# Global billing service instance
billing_service = BillingService()
