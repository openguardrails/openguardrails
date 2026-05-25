-- Migration: Change medium risk default action to anonymize
-- Description: Update default_input_medium_risk_action from 'switch_private_model' to 'anonymize'
--              for both tenant-level defaults and database column default.
-- Version: 054
-- Date: 2026-01-11

BEGIN;

-- ============================================================================
-- Step 1: Update column default value for new records
-- ============================================================================

ALTER TABLE tenant_data_leakage_policies
ALTER COLUMN default_input_medium_risk_action SET DEFAULT 'anonymize';

-- ============================================================================
-- Step 2: Update existing records that still have the old default value
-- ============================================================================

-- Update tenant policies that have the old default values
UPDATE tenant_data_leakage_policies
SET default_input_medium_risk_action = 'anonymize',
    updated_at = CURRENT_TIMESTAMP
WHERE default_input_medium_risk_action IN ('switch_private_model', 'switch_safe_model');

COMMIT;
