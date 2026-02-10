-- Migration: 062_add_quota_purchase
-- Description: Add purchased quota columns to tenant_subscriptions for pay-per-use quota purchase (Chinese users)
-- Date: 2026-02-09

-- Add purchased_quota column (tracks remaining purchased calls)
ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS purchased_quota INTEGER DEFAULT 0;

-- Add purchased_quota_expires_at column (when purchased quota expires)
ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS purchased_quota_expires_at TIMESTAMPTZ;

-- Index for efficient lookup of active purchased quotas
CREATE INDEX IF NOT EXISTS idx_tenant_subs_pq_expires
  ON tenant_subscriptions(purchased_quota_expires_at) WHERE purchased_quota > 0;
