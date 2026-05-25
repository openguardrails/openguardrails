"""
Migration: Add billing system with tenant subscriptions and update RPS defaults
Created: 2025-10-24
"""

import sys
import os
from pathlib import Path

# Add backend directory to Python path
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

from sqlalchemy import text
from database.connection import engine
from utils.logger import setup_logger

logger = setup_logger()

def upgrade():
    """Add tenant subscriptions table and update rate limit defaults"""

    with engine.connect() as conn:
        try:
            logger.info("Starting migration 008: Add billing system")

            # 1. Create tenant_subscriptions table
            logger.info("Creating tenant_subscriptions table...")
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS tenant_subscriptions (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    tenant_id UUID UNIQUE NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
                    subscription_type VARCHAR(20) NOT NULL DEFAULT 'free',
                    monthly_quota INTEGER NOT NULL DEFAULT 10000,
                    current_month_usage INTEGER NOT NULL DEFAULT 0,
                    usage_reset_at TIMESTAMP WITH TIME ZONE NOT NULL,
                    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
                );
            """))

            # 2. Create index on tenant_id for faster lookups
            logger.info("Creating index on tenant_subscriptions.tenant_id...")
            conn.execute(text("""
                CREATE INDEX IF NOT EXISTS idx_tenant_subscriptions_tenant_id
                ON tenant_subscriptions(tenant_id);
            """))

            # 3. Create index on subscription_type for admin queries
            logger.info("Creating index on tenant_subscriptions.subscription_type...")
            conn.execute(text("""
                CREATE INDEX IF NOT EXISTS idx_tenant_subscriptions_type
                ON tenant_subscriptions(subscription_type);
            """))

            # 4. Initialize subscriptions for all existing tenants
            # Each tenant gets a reset date 30 days from now (approximately 1 month)
            logger.info("Initializing subscriptions for existing tenants...")
            conn.execute(text("""
                INSERT INTO tenant_subscriptions (tenant_id, subscription_type, monthly_quota, current_month_usage, usage_reset_at)
                SELECT
                    id,
                    'free',
                    10000,
                    0,
                    NOW() + INTERVAL '30 days'
                FROM tenants
                WHERE id NOT IN (SELECT tenant_id FROM tenant_subscriptions)
                ON CONFLICT (tenant_id) DO NOTHING;
            """))

            # 5. Update default RPS from 1 to 10 for all existing rate limits
            logger.info("Updating default RPS from 1 to 10...")
            conn.execute(text("""
                UPDATE tenant_rate_limits
                SET requests_per_second = 10
                WHERE requests_per_second = 1;
            """))

            # 6. Update the default value in tenant_rate_limits table definition
            # Note: This will only affect new rows, existing rows are updated above
            logger.info("Updating default RPS for new tenants...")
            conn.execute(text("""
                ALTER TABLE tenant_rate_limits
                ALTER COLUMN requests_per_second SET DEFAULT 10;
            """))

            # 7. Create rate limits for tenants that don't have them (with new default)
            logger.info("Creating rate limits for tenants without them...")
            conn.execute(text("""
                INSERT INTO tenant_rate_limits (tenant_id, requests_per_second, is_active)
                SELECT
                    id,
                    10,
                    TRUE
                FROM tenants
                WHERE id NOT IN (SELECT tenant_id FROM tenant_rate_limits)
                ON CONFLICT (tenant_id) DO NOTHING;
            """))

            conn.commit()
            logger.info("Migration 008 completed successfully!")

        except Exception as e:
            conn.rollback()
            logger.error(f"Migration 008 failed: {e}")
            raise

def downgrade():
    """Revert billing system changes"""

    with engine.connect() as conn:
        try:
            logger.info("Starting downgrade of migration 008")

            # 1. Drop tenant_subscriptions table
            logger.info("Dropping tenant_subscriptions table...")
            conn.execute(text("DROP TABLE IF EXISTS tenant_subscriptions CASCADE;"))

            # 2. Revert RPS default back to 1
            logger.info("Reverting default RPS back to 1...")
            conn.execute(text("""
                ALTER TABLE tenant_rate_limits
                ALTER COLUMN requests_per_second SET DEFAULT 1;
            """))

            # 3. Update existing rate limits back to 1
            logger.info("Updating existing RPS values back to 1...")
            conn.execute(text("""
                UPDATE tenant_rate_limits
                SET requests_per_second = 1
                WHERE requests_per_second = 10;
            """))

            conn.commit()
            logger.info("Migration 008 downgrade completed successfully!")

        except Exception as e:
            conn.rollback()
            logger.error(f"Migration 008 downgrade failed: {e}")
            raise

if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "downgrade":
        downgrade()
    else:
        upgrade()
