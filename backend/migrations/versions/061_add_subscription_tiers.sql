-- Migration: Add subscription tiers support
-- Version: 061
-- Description: Add subscription_tiers table for tiered pricing, add subscription_tier
--              and alipay_agreement_no columns to tenant_subscriptions

-- Add subscription_tier to tenant_subscriptions
ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS subscription_tier INTEGER DEFAULT 0;
-- tier 0 = free, 1-9 = paid tiers

-- Add alipay_agreement_no for recurring billing (周期扣款)
ALTER TABLE tenant_subscriptions ADD COLUMN IF NOT EXISTS alipay_agreement_no VARCHAR(255);

-- Create subscription_tiers reference table
CREATE TABLE IF NOT EXISTS subscription_tiers (
    id SERIAL PRIMARY KEY,
    tier_number INTEGER NOT NULL UNIQUE,
    tier_name VARCHAR(100) NOT NULL,
    monthly_quota INTEGER NOT NULL,
    price_usd DECIMAL(10,2) NOT NULL,
    price_cny DECIMAL(10,2) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    display_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert 9 tiers (names match call counts directly)
INSERT INTO subscription_tiers (tier_number, tier_name, monthly_quota, price_usd, price_cny, display_order) VALUES
(1, '40K Calls', 40000, 400, 400, 1),
(2, '50K Calls', 50000, 450, 450, 2),
(3, '75K Calls', 75000, 525, 525, 3),
(4, '100K Calls', 100000, 600, 600, 4),
(5, '150K Calls', 150000, 825, 825, 5),
(6, '200K Calls', 200000, 1100, 1100, 6),
(7, '300K Calls', 300000, 1650, 1650, 7),
(8, '400K Calls', 400000, 2000, 2000, 8),
(9, '500K Calls', 500000, 2500, 2500, 9)
ON CONFLICT (tier_number) DO NOTHING;

-- Migrate existing subscribed users to tier 4 (100k, closest match)
UPDATE tenant_subscriptions SET subscription_tier = 4
WHERE subscription_type = 'subscribed' AND (subscription_tier IS NULL OR subscription_tier = 0);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_subscription_tiers_tier_number ON subscription_tiers(tier_number);
CREATE INDEX IF NOT EXISTS idx_tenant_subscriptions_tier ON tenant_subscriptions(subscription_tier);
