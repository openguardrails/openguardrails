#!/usr/bin/env python3
"""
Migration script to create subscriptions for existing tenants
This script creates free subscriptions for any tenants that don't have one yet.
"""

import os
import sys
from datetime import datetime, timedelta, timezone
from uuid import UUID

# Add backend directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'backend'))

from database.connection import SessionLocal
from database.models import Tenant, TenantSubscription
from utils.logger import setup_logger

logger = setup_logger()


def calculate_next_reset_date(from_date: datetime = None) -> datetime:
    """Calculate the next quota reset date"""
    if from_date is None:
        from_date = datetime.now()

    # Get the day of month from subscription start
    reset_day = from_date.day

    # Calculate next reset based on current time
    year = from_date.year
    month = from_date.month

    # Move to next month
    if month == 12:
        month = 1
        year += 1
    else:
        month += 1

    # Handle months with fewer days
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

    return next_reset


def create_missing_subscriptions():
    """Create free subscriptions for tenants that don't have one"""
    db = SessionLocal()
    created_count = 0
    skipped_count = 0
    error_count = 0

    try:
        # Get all active and verified tenants
        tenants = db.query(Tenant).filter(
            Tenant.is_active == True,
            Tenant.is_verified == True
        ).all()

        logger.info(f"Found {len(tenants)} active and verified tenants")

        for tenant in tenants:
            try:
                # Check if subscription already exists
                existing = db.query(TenantSubscription).filter(
                    TenantSubscription.tenant_id == tenant.id
                ).first()

                if existing:
                    logger.debug(f"Subscription already exists for tenant {tenant.email}")
                    skipped_count += 1
                    continue

                # Create free subscription
                current_time = datetime.now(timezone.utc)
                reset_date = calculate_next_reset_date(current_time)

                subscription = TenantSubscription(
                    tenant_id=tenant.id,
                    subscription_type='free',
                    monthly_quota=1000,
                    current_month_usage=0,
                    usage_reset_at=reset_date,
                    created_at=current_time,
                    updated_at=current_time
                )

                db.add(subscription)
                db.commit()

                logger.info(f"Created free subscription for tenant {tenant.email}")
                created_count += 1

            except Exception as e:
                logger.error(f"Failed to create subscription for tenant {tenant.email}: {e}")
                db.rollback()
                error_count += 1
                continue

        logger.info(f"""
Migration completed:
- Created: {created_count} subscriptions
- Skipped: {skipped_count} (already exist)
- Errors: {error_count}
""")

        return created_count, skipped_count, error_count

    except Exception as e:
        logger.error(f"Migration failed: {e}")
        raise
    finally:
        db.close()


if __name__ == "__main__":
    print("Creating missing tenant subscriptions...")
    created, skipped, errors = create_missing_subscriptions()
    print(f"\nResults:")
    print(f"  Created: {created}")
    print(f"  Skipped: {skipped}")
    print(f"  Errors: {errors}")

    if errors > 0:
        sys.exit(1)
