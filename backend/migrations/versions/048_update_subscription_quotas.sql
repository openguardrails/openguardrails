-- Migration: Update subscription quotas to match new configuration
-- Version: 048
-- Date: 2025-01-XX
-- Description: Update existing subscription monthly_quota values to match new configuration
--              Free users: 1000 (was 10000)
--              Subscribed users: 100000 (was 1000000)

-- Update free subscriptions to 1000
UPDATE tenant_subscriptions
SET monthly_quota = 1000
WHERE subscription_type = 'free' AND monthly_quota != 1000;

-- Update subscribed subscriptions to 100000
UPDATE tenant_subscriptions
SET monthly_quota = 100000
WHERE subscription_type = 'subscribed' AND monthly_quota != 100000;

-- Update the default value for new subscriptions (free plan default)
ALTER TABLE tenant_subscriptions
ALTER COLUMN monthly_quota SET DEFAULT 1000;

-- Log the changes
DO $$
DECLARE
    free_updated INTEGER;
    subscribed_updated INTEGER;
BEGIN
    SELECT COUNT(*) INTO free_updated
    FROM tenant_subscriptions
    WHERE subscription_type = 'free' AND monthly_quota = 1000;
    
    SELECT COUNT(*) INTO subscribed_updated
    FROM tenant_subscriptions
    WHERE subscription_type = 'subscribed' AND monthly_quota = 100000;
    
    RAISE NOTICE 'Updated % free subscriptions to 1000 quota', free_updated;
    RAISE NOTICE 'Updated % subscribed subscriptions to 100000 quota', subscribed_updated;
END $$;

