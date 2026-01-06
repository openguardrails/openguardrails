-- Migration: Separate input and output data leakage policies
-- Description: Split data leakage policies into input (prevent external leakage)
--              and output (prevent internal unauthorized access) configurations.
--              Add tenant-level defaults with application-level overrides.
-- Version: 040
-- Date: 2026-01-05

BEGIN;

-- ============================================================================
-- Step 1: Create tenant-level default data leakage policies table
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenant_data_leakage_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,

    -- Input Policy Defaults (prevent external data leakage)
    -- Actions: 'block' | 'switch_private_model' | 'anonymize' | 'pass'
    default_input_high_risk_action VARCHAR(50) NOT NULL DEFAULT 'block',
    default_input_medium_risk_action VARCHAR(50) NOT NULL DEFAULT 'switch_private_model',
    default_input_low_risk_action VARCHAR(50) NOT NULL DEFAULT 'anonymize',

    -- Output Policy Defaults (prevent internal unauthorized access)
    -- Boolean flags: whether to anonymize output for each risk level
    default_output_high_risk_anonymize BOOLEAN NOT NULL DEFAULT TRUE,
    default_output_medium_risk_anonymize BOOLEAN NOT NULL DEFAULT TRUE,
    default_output_low_risk_anonymize BOOLEAN NOT NULL DEFAULT FALSE,

    -- Default Private Model Configuration
    default_private_model_id UUID REFERENCES upstream_api_configs(id) ON DELETE SET NULL,

    -- Default Feature Flags
    default_enable_format_detection BOOLEAN NOT NULL DEFAULT TRUE,
    default_enable_smart_segmentation BOOLEAN NOT NULL DEFAULT TRUE,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenant_dlp_tenant_id ON tenant_data_leakage_policies(tenant_id);

-- ============================================================================
-- Step 2: Backup existing application policies
-- ============================================================================

CREATE TABLE IF NOT EXISTS application_data_leakage_policies_backup AS
SELECT * FROM application_data_leakage_policies;

-- ============================================================================
-- Step 3: Rename existing table columns for input policy
-- ============================================================================

-- Rename action columns to input-specific names
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'application_data_leakage_policies'
               AND column_name = 'high_risk_action') THEN
        ALTER TABLE application_data_leakage_policies
        RENAME COLUMN high_risk_action TO input_high_risk_action;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'application_data_leakage_policies'
               AND column_name = 'medium_risk_action') THEN
        ALTER TABLE application_data_leakage_policies
        RENAME COLUMN medium_risk_action TO input_medium_risk_action;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'application_data_leakage_policies'
               AND column_name = 'low_risk_action') THEN
        ALTER TABLE application_data_leakage_policies
        RENAME COLUMN low_risk_action TO input_low_risk_action;
    END IF;
END $$;

-- ============================================================================
-- Step 4: Add output policy columns to application table
-- ============================================================================

-- Add output anonymization flags (NULL = use tenant default)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'application_data_leakage_policies'
                   AND column_name = 'output_high_risk_anonymize') THEN
        ALTER TABLE application_data_leakage_policies
        ADD COLUMN output_high_risk_anonymize BOOLEAN DEFAULT NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'application_data_leakage_policies'
                   AND column_name = 'output_medium_risk_anonymize') THEN
        ALTER TABLE application_data_leakage_policies
        ADD COLUMN output_medium_risk_anonymize BOOLEAN DEFAULT NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'application_data_leakage_policies'
                   AND column_name = 'output_low_risk_anonymize') THEN
        ALTER TABLE application_data_leakage_policies
        ADD COLUMN output_low_risk_anonymize BOOLEAN DEFAULT NULL;
    END IF;
END $$;

-- ============================================================================
-- Step 5: Make existing columns nullable for override capability
-- ============================================================================

-- Make input action columns nullable (NULL = use tenant default)
ALTER TABLE application_data_leakage_policies
ALTER COLUMN input_high_risk_action DROP NOT NULL,
ALTER COLUMN input_medium_risk_action DROP NOT NULL,
ALTER COLUMN input_low_risk_action DROP NOT NULL,
ALTER COLUMN enable_format_detection DROP NOT NULL,
ALTER COLUMN enable_smart_segmentation DROP NOT NULL;

-- Set default values to NULL for future records
ALTER TABLE application_data_leakage_policies
ALTER COLUMN input_high_risk_action SET DEFAULT NULL,
ALTER COLUMN input_medium_risk_action SET DEFAULT NULL,
ALTER COLUMN input_low_risk_action SET DEFAULT NULL,
ALTER COLUMN enable_format_detection SET DEFAULT NULL,
ALTER COLUMN enable_smart_segmentation SET DEFAULT NULL;

-- ============================================================================
-- Step 6: Migrate existing data to tenant defaults
-- ============================================================================

-- Create tenant-level defaults from existing application policies
-- Use the most common settings from each tenant's applications
INSERT INTO tenant_data_leakage_policies (
    tenant_id,
    default_input_high_risk_action,
    default_input_medium_risk_action,
    default_input_low_risk_action,
    default_private_model_id,
    default_enable_format_detection,
    default_enable_smart_segmentation,
    default_output_high_risk_anonymize,
    default_output_medium_risk_anonymize,
    default_output_low_risk_anonymize
)
SELECT DISTINCT ON (tenant_id)
    tenant_id,
    COALESCE(input_high_risk_action, 'block'),
    COALESCE(input_medium_risk_action, 'switch_private_model'),
    COALESCE(input_low_risk_action, 'anonymize'),
    private_model_id,
    COALESCE(enable_format_detection, TRUE),
    COALESCE(enable_smart_segmentation, TRUE),
    TRUE,  -- default: anonymize high risk output
    TRUE,  -- default: anonymize medium risk output
    FALSE  -- default: don't anonymize low risk output
FROM application_data_leakage_policies
ORDER BY tenant_id, created_at
ON CONFLICT (tenant_id) DO NOTHING;

-- Also create defaults for tenants without any application policies yet
INSERT INTO tenant_data_leakage_policies (tenant_id)
SELECT id FROM tenants
WHERE id NOT IN (SELECT tenant_id FROM tenant_data_leakage_policies)
ON CONFLICT (tenant_id) DO NOTHING;

-- ============================================================================
-- Step 7: Clear application-level values that match tenant defaults
-- ============================================================================

-- For each application, if its values match the tenant default, set to NULL
UPDATE application_data_leakage_policies app
SET
    input_high_risk_action = CASE
        WHEN app.input_high_risk_action = tenant.default_input_high_risk_action
        THEN NULL ELSE app.input_high_risk_action END,
    input_medium_risk_action = CASE
        WHEN app.input_medium_risk_action = tenant.default_input_medium_risk_action
        THEN NULL ELSE app.input_medium_risk_action END,
    input_low_risk_action = CASE
        WHEN app.input_low_risk_action = tenant.default_input_low_risk_action
        THEN NULL ELSE app.input_low_risk_action END,
    private_model_id = CASE
        WHEN app.private_model_id = tenant.default_private_model_id
        OR (app.private_model_id IS NULL AND tenant.default_private_model_id IS NULL)
        THEN NULL ELSE app.private_model_id END,
    enable_format_detection = CASE
        WHEN app.enable_format_detection = tenant.default_enable_format_detection
        THEN NULL ELSE app.enable_format_detection END,
    enable_smart_segmentation = CASE
        WHEN app.enable_smart_segmentation = tenant.default_enable_smart_segmentation
        THEN NULL ELSE app.enable_smart_segmentation END
FROM tenant_data_leakage_policies tenant
WHERE app.tenant_id = tenant.tenant_id;

-- ============================================================================
-- Step 8: Add comments for documentation
-- ============================================================================

COMMENT ON TABLE tenant_data_leakage_policies IS
'Tenant-level default data leakage prevention policies. All applications inherit these defaults unless explicitly overridden.';

COMMENT ON COLUMN tenant_data_leakage_policies.default_input_high_risk_action IS
'Default action for high-risk input data: block | switch_private_model | anonymize | pass';

COMMENT ON COLUMN tenant_data_leakage_policies.default_output_high_risk_anonymize IS
'Default flag: whether to anonymize high-risk data in model outputs (prevent internal unauthorized access)';

COMMENT ON TABLE application_data_leakage_policies IS
'Application-level data leakage policy overrides. NULL values inherit from tenant defaults.';

COMMENT ON COLUMN application_data_leakage_policies.input_high_risk_action IS
'Override input action for high-risk data. NULL = use tenant default';

COMMENT ON COLUMN application_data_leakage_policies.output_high_risk_anonymize IS
'Override output anonymization for high-risk data. NULL = use tenant default';

COMMIT;
