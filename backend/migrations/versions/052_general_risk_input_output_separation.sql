-- Migration: 052_general_risk_input_output_separation
-- Description: Separate general risk policy into input and output policies
-- Created: 2026-01-10

-- 1. Add input-specific general risk policy fields to tenant_data_leakage_policies
-- Rename existing fields to input-specific (they were previously used for input only)
ALTER TABLE tenant_data_leakage_policies
ADD COLUMN IF NOT EXISTS default_general_input_high_risk_action VARCHAR(50) DEFAULT 'block';

ALTER TABLE tenant_data_leakage_policies
ADD COLUMN IF NOT EXISTS default_general_input_medium_risk_action VARCHAR(50) DEFAULT 'replace';

ALTER TABLE tenant_data_leakage_policies
ADD COLUMN IF NOT EXISTS default_general_input_low_risk_action VARCHAR(50) DEFAULT 'pass';

-- 2. Add output-specific general risk policy fields to tenant_data_leakage_policies
ALTER TABLE tenant_data_leakage_policies
ADD COLUMN IF NOT EXISTS default_general_output_high_risk_action VARCHAR(50) DEFAULT 'block';

ALTER TABLE tenant_data_leakage_policies
ADD COLUMN IF NOT EXISTS default_general_output_medium_risk_action VARCHAR(50) DEFAULT 'replace';

ALTER TABLE tenant_data_leakage_policies
ADD COLUMN IF NOT EXISTS default_general_output_low_risk_action VARCHAR(50) DEFAULT 'pass';

-- 3. Migrate existing data: copy old general risk values to new input fields
UPDATE tenant_data_leakage_policies
SET default_general_input_high_risk_action = COALESCE(default_general_high_risk_action, 'block'),
    default_general_input_medium_risk_action = COALESCE(default_general_medium_risk_action, 'replace'),
    default_general_input_low_risk_action = COALESCE(default_general_low_risk_action, 'pass')
WHERE default_general_input_high_risk_action IS NULL
   OR default_general_input_medium_risk_action IS NULL
   OR default_general_input_low_risk_action IS NULL;

-- 4. Add input-specific general risk policy fields to application_data_leakage_policies
ALTER TABLE application_data_leakage_policies
ADD COLUMN IF NOT EXISTS general_input_high_risk_action VARCHAR(50) DEFAULT NULL;

ALTER TABLE application_data_leakage_policies
ADD COLUMN IF NOT EXISTS general_input_medium_risk_action VARCHAR(50) DEFAULT NULL;

ALTER TABLE application_data_leakage_policies
ADD COLUMN IF NOT EXISTS general_input_low_risk_action VARCHAR(50) DEFAULT NULL;

-- 5. Add output-specific general risk policy fields to application_data_leakage_policies
ALTER TABLE application_data_leakage_policies
ADD COLUMN IF NOT EXISTS general_output_high_risk_action VARCHAR(50) DEFAULT NULL;

ALTER TABLE application_data_leakage_policies
ADD COLUMN IF NOT EXISTS general_output_medium_risk_action VARCHAR(50) DEFAULT NULL;

ALTER TABLE application_data_leakage_policies
ADD COLUMN IF NOT EXISTS general_output_low_risk_action VARCHAR(50) DEFAULT NULL;

-- 6. Migrate existing data: copy old general risk values to new input fields
UPDATE application_data_leakage_policies
SET general_input_high_risk_action = general_high_risk_action,
    general_input_medium_risk_action = general_medium_risk_action,
    general_input_low_risk_action = general_low_risk_action
WHERE general_high_risk_action IS NOT NULL
   OR general_medium_risk_action IS NOT NULL
   OR general_low_risk_action IS NOT NULL;

-- Note: Old columns (default_general_high/medium/low_risk_action and general_high/medium/low_risk_action)
-- are kept for backward compatibility. They can be removed in a future migration after
-- confirming all code paths have been updated.
