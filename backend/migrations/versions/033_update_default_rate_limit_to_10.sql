-- Migration: update_default_rate_limit_to_10
-- Version: 033
-- Date: 2025-12-03
-- Author: System

-- Description:
-- Update existing tenant rate limits from 1 RPS to 10 RPS
-- This migration ensures all existing rate limit configurations use the correct default value of 10 requests per second
-- New rate limits created after this migration will automatically use the default value of 10 from the model definition

DO $$
BEGIN
    -- Update all rate limits that are set to 1 RPS to 10 RPS
    -- This catches any records created before the default was changed
    UPDATE tenant_rate_limits
    SET requests_per_second = 10,
        updated_at = CURRENT_TIMESTAMP
    WHERE requests_per_second = 1;

    RAISE NOTICE 'Updated % rate limit entries from 1 RPS to 10 RPS',
        (SELECT COUNT(*) FROM tenant_rate_limits WHERE requests_per_second = 10);
END $$;

-- Verify the update
DO $$
DECLARE
    old_count INTEGER;
    new_count INTEGER;
BEGIN
    -- Count any remaining 1 RPS entries (should be 0)
    SELECT COUNT(*) INTO old_count FROM tenant_rate_limits WHERE requests_per_second = 1;

    -- Count all 10 RPS entries
    SELECT COUNT(*) INTO new_count FROM tenant_rate_limits WHERE requests_per_second = 10;

    RAISE NOTICE 'Rate limit verification:';
    RAISE NOTICE '  - Entries with 1 RPS: %', old_count;
    RAISE NOTICE '  - Entries with 10 RPS: %', new_count;

    IF old_count > 0 THEN
        RAISE WARNING 'Still have % entries with 1 RPS - migration may need review', old_count;
    END IF;
END $$;
