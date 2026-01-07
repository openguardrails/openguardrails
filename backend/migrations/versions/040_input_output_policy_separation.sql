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
    -- Boolean flags: whether to anonymize output for each risk level (legacy)
    default_output_high_risk_anonymize BOOLEAN NOT NULL DEFAULT TRUE,
    default_output_medium_risk_anonymize BOOLEAN NOT NULL DEFAULT TRUE,
    default_output_low_risk_anonymize BOOLEAN NOT NULL DEFAULT FALSE,

    -- Output Policy Defaults - Action type (same as input policy)
    default_output_high_risk_action VARCHAR(50) NOT NULL DEFAULT 'block',
    default_output_medium_risk_action VARCHAR(50) NOT NULL DEFAULT 'anonymize',
    default_output_low_risk_action VARCHAR(50) NOT NULL DEFAULT 'pass',

    -- General Risk Policy Defaults (security, safety, company policy violations)
    default_general_high_risk_action VARCHAR(50) NOT NULL DEFAULT 'block',
    default_general_medium_risk_action VARCHAR(50) NOT NULL DEFAULT 'replace',
    default_general_low_risk_action VARCHAR(50) NOT NULL DEFAULT 'pass',

    -- Note: Default private model is determined by upstream_api_configs.is_default_private_model = true
    -- (No column needed here as it's stored in upstream_api_configs)

    -- Default Feature Flags
    default_enable_format_detection BOOLEAN NOT NULL DEFAULT TRUE,
    default_enable_smart_segmentation BOOLEAN NOT NULL DEFAULT TRUE,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tenant_dlp_tenant_id ON tenant_data_leakage_policies(tenant_id);

-- Add missing columns to tenant_data_leakage_policies if they don't exist
-- (handles case where table was created by partial/older migration run or SQLAlchemy create_all)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tenant_data_leakage_policies'
                   AND column_name = 'default_input_high_risk_action') THEN
        ALTER TABLE tenant_data_leakage_policies
        ADD COLUMN default_input_high_risk_action VARCHAR(50) NOT NULL DEFAULT 'block';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tenant_data_leakage_policies'
                   AND column_name = 'default_input_medium_risk_action') THEN
        ALTER TABLE tenant_data_leakage_policies
        ADD COLUMN default_input_medium_risk_action VARCHAR(50) NOT NULL DEFAULT 'switch_private_model';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tenant_data_leakage_policies'
                   AND column_name = 'default_input_low_risk_action') THEN
        ALTER TABLE tenant_data_leakage_policies
        ADD COLUMN default_input_low_risk_action VARCHAR(50) NOT NULL DEFAULT 'anonymize';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tenant_data_leakage_policies'
                   AND column_name = 'default_output_high_risk_anonymize') THEN
        ALTER TABLE tenant_data_leakage_policies
        ADD COLUMN default_output_high_risk_anonymize BOOLEAN NOT NULL DEFAULT TRUE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tenant_data_leakage_policies'
                   AND column_name = 'default_output_medium_risk_anonymize') THEN
        ALTER TABLE tenant_data_leakage_policies
        ADD COLUMN default_output_medium_risk_anonymize BOOLEAN NOT NULL DEFAULT TRUE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tenant_data_leakage_policies'
                   AND column_name = 'default_output_low_risk_anonymize') THEN
        ALTER TABLE tenant_data_leakage_policies
        ADD COLUMN default_output_low_risk_anonymize BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tenant_data_leakage_policies'
                   AND column_name = 'default_enable_format_detection') THEN
        ALTER TABLE tenant_data_leakage_policies
        ADD COLUMN default_enable_format_detection BOOLEAN NOT NULL DEFAULT TRUE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tenant_data_leakage_policies'
                   AND column_name = 'default_enable_smart_segmentation') THEN
        ALTER TABLE tenant_data_leakage_policies
        ADD COLUMN default_enable_smart_segmentation BOOLEAN NOT NULL DEFAULT TRUE;
    END IF;
END $$;

-- Add output action columns (added in model, may not exist in DB)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tenant_data_leakage_policies'
                   AND column_name = 'default_output_high_risk_action') THEN
        ALTER TABLE tenant_data_leakage_policies
        ADD COLUMN default_output_high_risk_action VARCHAR(50) NOT NULL DEFAULT 'block';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tenant_data_leakage_policies'
                   AND column_name = 'default_output_medium_risk_action') THEN
        ALTER TABLE tenant_data_leakage_policies
        ADD COLUMN default_output_medium_risk_action VARCHAR(50) NOT NULL DEFAULT 'anonymize';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tenant_data_leakage_policies'
                   AND column_name = 'default_output_low_risk_action') THEN
        ALTER TABLE tenant_data_leakage_policies
        ADD COLUMN default_output_low_risk_action VARCHAR(50) NOT NULL DEFAULT 'pass';
    END IF;
END $$;

-- Add general risk policy columns (added in model, may not exist in DB)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tenant_data_leakage_policies'
                   AND column_name = 'default_general_high_risk_action') THEN
        ALTER TABLE tenant_data_leakage_policies
        ADD COLUMN default_general_high_risk_action VARCHAR(50) NOT NULL DEFAULT 'block';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tenant_data_leakage_policies'
                   AND column_name = 'default_general_medium_risk_action') THEN
        ALTER TABLE tenant_data_leakage_policies
        ADD COLUMN default_general_medium_risk_action VARCHAR(50) NOT NULL DEFAULT 'replace';
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'tenant_data_leakage_policies'
                   AND column_name = 'default_general_low_risk_action') THEN
        ALTER TABLE tenant_data_leakage_policies
        ADD COLUMN default_general_low_risk_action VARCHAR(50) NOT NULL DEFAULT 'pass';
    END IF;
END $$;

-- Set database-level defaults for columns that may have been created by SQLAlchemy without defaults
DO $$
BEGIN
    ALTER TABLE tenant_data_leakage_policies ALTER COLUMN id SET DEFAULT gen_random_uuid();
    ALTER TABLE tenant_data_leakage_policies ALTER COLUMN default_input_high_risk_action SET DEFAULT 'block';
    ALTER TABLE tenant_data_leakage_policies ALTER COLUMN default_input_medium_risk_action SET DEFAULT 'switch_private_model';
    ALTER TABLE tenant_data_leakage_policies ALTER COLUMN default_input_low_risk_action SET DEFAULT 'anonymize';
    ALTER TABLE tenant_data_leakage_policies ALTER COLUMN default_output_high_risk_anonymize SET DEFAULT TRUE;
    ALTER TABLE tenant_data_leakage_policies ALTER COLUMN default_output_medium_risk_anonymize SET DEFAULT TRUE;
    ALTER TABLE tenant_data_leakage_policies ALTER COLUMN default_output_low_risk_anonymize SET DEFAULT FALSE;
    ALTER TABLE tenant_data_leakage_policies ALTER COLUMN default_output_high_risk_action SET DEFAULT 'block';
    ALTER TABLE tenant_data_leakage_policies ALTER COLUMN default_output_medium_risk_action SET DEFAULT 'anonymize';
    ALTER TABLE tenant_data_leakage_policies ALTER COLUMN default_output_low_risk_action SET DEFAULT 'pass';
    ALTER TABLE tenant_data_leakage_policies ALTER COLUMN default_general_high_risk_action SET DEFAULT 'block';
    ALTER TABLE tenant_data_leakage_policies ALTER COLUMN default_general_medium_risk_action SET DEFAULT 'replace';
    ALTER TABLE tenant_data_leakage_policies ALTER COLUMN default_general_low_risk_action SET DEFAULT 'pass';
    ALTER TABLE tenant_data_leakage_policies ALTER COLUMN default_enable_format_detection SET DEFAULT TRUE;
    ALTER TABLE tenant_data_leakage_policies ALTER COLUMN default_enable_smart_segmentation SET DEFAULT TRUE;
EXCEPTION WHEN OTHERS THEN
    -- Ignore errors if columns don't exist yet
    NULL;
END $$;

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
-- Wrap in DO blocks to handle cases where columns might not exist or are already nullable
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'application_data_leakage_policies'
               AND column_name = 'input_high_risk_action'
               AND is_nullable = 'NO') THEN
        ALTER TABLE application_data_leakage_policies ALTER COLUMN input_high_risk_action DROP NOT NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'application_data_leakage_policies'
               AND column_name = 'input_medium_risk_action'
               AND is_nullable = 'NO') THEN
        ALTER TABLE application_data_leakage_policies ALTER COLUMN input_medium_risk_action DROP NOT NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'application_data_leakage_policies'
               AND column_name = 'input_low_risk_action'
               AND is_nullable = 'NO') THEN
        ALTER TABLE application_data_leakage_policies ALTER COLUMN input_low_risk_action DROP NOT NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'application_data_leakage_policies'
               AND column_name = 'enable_format_detection'
               AND is_nullable = 'NO') THEN
        ALTER TABLE application_data_leakage_policies ALTER COLUMN enable_format_detection DROP NOT NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'application_data_leakage_policies'
               AND column_name = 'enable_smart_segmentation'
               AND is_nullable = 'NO') THEN
        ALTER TABLE application_data_leakage_policies ALTER COLUMN enable_smart_segmentation DROP NOT NULL;
    END IF;
END $$;

-- Set default values to NULL for future records
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'application_data_leakage_policies'
               AND column_name = 'input_high_risk_action') THEN
        ALTER TABLE application_data_leakage_policies ALTER COLUMN input_high_risk_action SET DEFAULT NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'application_data_leakage_policies'
               AND column_name = 'input_medium_risk_action') THEN
        ALTER TABLE application_data_leakage_policies ALTER COLUMN input_medium_risk_action SET DEFAULT NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'application_data_leakage_policies'
               AND column_name = 'input_low_risk_action') THEN
        ALTER TABLE application_data_leakage_policies ALTER COLUMN input_low_risk_action SET DEFAULT NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'application_data_leakage_policies'
               AND column_name = 'enable_format_detection') THEN
        ALTER TABLE application_data_leakage_policies ALTER COLUMN enable_format_detection SET DEFAULT NULL;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'application_data_leakage_policies'
               AND column_name = 'enable_smart_segmentation') THEN
        ALTER TABLE application_data_leakage_policies ALTER COLUMN enable_smart_segmentation SET DEFAULT NULL;
    END IF;
END $$;

-- ============================================================================
-- Step 6: Ensure id column has default (fix for tables created by SQLAlchemy)
-- ============================================================================

DO $$
BEGIN
    -- Add default to id column if missing (handles tables created by SQLAlchemy create_all)
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'tenant_data_leakage_policies'
               AND column_name = 'id'
               AND column_default IS NULL) THEN
        ALTER TABLE tenant_data_leakage_policies ALTER COLUMN id SET DEFAULT gen_random_uuid();
    END IF;
END $$;

-- ============================================================================
-- Step 7: Migrate existing data to tenant defaults
-- ============================================================================

-- Create tenant-level defaults from existing application policies
-- Use the most common settings from each tenant's applications
-- Note: default_private_model is now determined by upstream_api_configs.is_default_private_model flag
-- Note: Explicitly use gen_random_uuid() for id to handle tables without default
INSERT INTO tenant_data_leakage_policies (
    id,
    tenant_id,
    default_input_high_risk_action,
    default_input_medium_risk_action,
    default_input_low_risk_action,
    default_output_high_risk_anonymize,
    default_output_medium_risk_anonymize,
    default_output_low_risk_anonymize,
    default_output_high_risk_action,
    default_output_medium_risk_action,
    default_output_low_risk_action,
    default_general_high_risk_action,
    default_general_medium_risk_action,
    default_general_low_risk_action,
    default_enable_format_detection,
    default_enable_smart_segmentation
)
SELECT DISTINCT ON (tenant_id)
    gen_random_uuid(),
    tenant_id,
    COALESCE(input_high_risk_action, 'block'),
    COALESCE(input_medium_risk_action, 'switch_private_model'),
    COALESCE(input_low_risk_action, 'anonymize'),
    TRUE,   -- default_output_high_risk_anonymize
    TRUE,   -- default_output_medium_risk_anonymize
    FALSE,  -- default_output_low_risk_anonymize
    'block',     -- default_output_high_risk_action
    'anonymize', -- default_output_medium_risk_action
    'pass',      -- default_output_low_risk_action
    'block',     -- default_general_high_risk_action
    'replace',   -- default_general_medium_risk_action
    'pass',      -- default_general_low_risk_action
    COALESCE(enable_format_detection, TRUE),
    COALESCE(enable_smart_segmentation, TRUE)
FROM application_data_leakage_policies
ORDER BY tenant_id, created_at
ON CONFLICT (tenant_id) DO NOTHING;

-- Also create defaults for tenants without any application policies yet
-- Note: Explicitly specify all columns to handle tables created by SQLAlchemy without defaults
INSERT INTO tenant_data_leakage_policies (
    id,
    tenant_id,
    default_input_high_risk_action,
    default_input_medium_risk_action,
    default_input_low_risk_action,
    default_output_high_risk_anonymize,
    default_output_medium_risk_anonymize,
    default_output_low_risk_anonymize,
    default_output_high_risk_action,
    default_output_medium_risk_action,
    default_output_low_risk_action,
    default_general_high_risk_action,
    default_general_medium_risk_action,
    default_general_low_risk_action,
    default_enable_format_detection,
    default_enable_smart_segmentation
)
SELECT
    gen_random_uuid(),
    id,
    'block',              -- default_input_high_risk_action
    'switch_private_model', -- default_input_medium_risk_action
    'anonymize',          -- default_input_low_risk_action
    TRUE,                 -- default_output_high_risk_anonymize
    TRUE,                 -- default_output_medium_risk_anonymize
    FALSE,                -- default_output_low_risk_anonymize
    'block',              -- default_output_high_risk_action
    'anonymize',          -- default_output_medium_risk_action
    'pass',               -- default_output_low_risk_action
    'block',              -- default_general_high_risk_action
    'replace',            -- default_general_medium_risk_action
    'pass',               -- default_general_low_risk_action
    TRUE,                 -- default_enable_format_detection
    TRUE                  -- default_enable_smart_segmentation
FROM tenants
WHERE id NOT IN (SELECT tenant_id FROM tenant_data_leakage_policies)
ON CONFLICT (tenant_id) DO NOTHING;

-- ============================================================================
-- Step 8: Clear application-level values that match tenant defaults
-- ============================================================================

-- For each application, if its values match the tenant default, set to NULL
-- Note: private_model_id is kept as-is since default is now determined by upstream_api_configs flag
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
    enable_format_detection = CASE
        WHEN app.enable_format_detection = tenant.default_enable_format_detection
        THEN NULL ELSE app.enable_format_detection END,
    enable_smart_segmentation = CASE
        WHEN app.enable_smart_segmentation = tenant.default_enable_smart_segmentation
        THEN NULL ELSE app.enable_smart_segmentation END
FROM tenant_data_leakage_policies tenant
WHERE app.tenant_id = tenant.tenant_id;

-- ============================================================================
-- Step 9: Add comments for documentation
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
