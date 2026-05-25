-- Migration: Add monthly scan limit fields to tenant_rate_limits table
-- Version: 032
-- Date: 2025-11-27
-- Description: Add monthly_scan_limit, current_month_usage, and usage_reset_at fields to track monthly scan usage

-- Add monthly_scan_limit column (default 10000, 0 means no limit)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tenant_rate_limits'
        AND column_name = 'monthly_scan_limit'
    ) THEN
        ALTER TABLE tenant_rate_limits
        ADD COLUMN monthly_scan_limit INTEGER NOT NULL DEFAULT 10000;
    END IF;
END $$;

-- Add current_month_usage column (default 0)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tenant_rate_limits'
        AND column_name = 'current_month_usage'
    ) THEN
        ALTER TABLE tenant_rate_limits
        ADD COLUMN current_month_usage INTEGER NOT NULL DEFAULT 0;
    END IF;
END $$;

-- Add usage_reset_at column (default current timestamp)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tenant_rate_limits'
        AND column_name = 'usage_reset_at'
    ) THEN
        ALTER TABLE tenant_rate_limits
        ADD COLUMN usage_reset_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW();
    END IF;
END $$;

-- Add index on usage_reset_at for efficient monthly reset queries
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'tenant_rate_limits'
        AND indexname = 'ix_tenant_rate_limits_usage_reset_at'
    ) THEN
        CREATE INDEX ix_tenant_rate_limits_usage_reset_at
        ON tenant_rate_limits(usage_reset_at);
    END IF;
END $$;

-- Comment on new columns
COMMENT ON COLUMN tenant_rate_limits.monthly_scan_limit IS 'Monthly scan limit per tenant/application (0 = unlimited)';
COMMENT ON COLUMN tenant_rate_limits.current_month_usage IS 'Current month scan usage count';
COMMENT ON COLUMN tenant_rate_limits.usage_reset_at IS 'Timestamp when usage counter was last reset (start of current month)';
