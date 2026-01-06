-- Migration: simplify_private_model_config
-- Version: 041
-- Date: 2026-01-06
-- Author: OpenGuardrails Team

-- Description:
-- Simplify private model configuration by:
-- 1. Rename is_data_safe to is_private_model for clarity
-- 2. Rename is_default_safe_model to is_default_private_model for consistency
-- 3. Remove safe_model_priority (no longer needed)
-- 4. Remove tenant_data_leakage_policies.default_safe_model_id (redundant)
-- Private model selection logic:
-- - Application can select specific private model via application_data_leakage_policies.private_model_id
-- - If not set, use tenant's default private model (upstream_api_configs.is_default_private_model = true)

-- Step 1: Rename is_data_safe to is_private_model in upstream_api_configs
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'upstream_api_configs' AND column_name = 'is_data_safe'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'upstream_api_configs' AND column_name = 'is_private_model'
    ) THEN
        ALTER TABLE upstream_api_configs RENAME COLUMN is_data_safe TO is_private_model;
        RAISE NOTICE 'Renamed is_data_safe to is_private_model';
    END IF;
END $$;

-- Step 2: Rename is_default_safe_model to is_default_private_model
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'upstream_api_configs' AND column_name = 'is_default_safe_model'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'upstream_api_configs' AND column_name = 'is_default_private_model'
    ) THEN
        ALTER TABLE upstream_api_configs RENAME COLUMN is_default_safe_model TO is_default_private_model;
        RAISE NOTICE 'Renamed is_default_safe_model to is_default_private_model';
    END IF;
END $$;

-- Step 3: Remove safe_model_priority column from upstream_api_configs
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'upstream_api_configs' AND column_name = 'safe_model_priority'
    ) THEN
        DROP INDEX IF EXISTS idx_upstream_api_configs_safe_model_priority;
        ALTER TABLE upstream_api_configs DROP COLUMN safe_model_priority;
        RAISE NOTICE 'Removed safe_model_priority column';
    END IF;
END $$;

-- Step 4: Remove default_safe_model_id from tenant_data_leakage_policies
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_name = 'tenant_data_leakage_policies'
    ) AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tenant_data_leakage_policies' AND column_name = 'default_safe_model_id'
    ) THEN
        ALTER TABLE tenant_data_leakage_policies
        DROP CONSTRAINT IF EXISTS tenant_data_leakage_policies_default_safe_model_id_fkey;
        ALTER TABLE tenant_data_leakage_policies DROP COLUMN default_safe_model_id;
        RAISE NOTICE 'Removed default_safe_model_id from tenant_data_leakage_policies';
    END IF;
END $$;

-- Step 5: Update indexes
DO $$
BEGIN
    -- Drop old indexes
    DROP INDEX IF EXISTS idx_upstream_api_configs_is_data_safe;
    DROP INDEX IF EXISTS idx_upstream_api_configs_is_default_safe_model;

    -- Create new indexes if not exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'upstream_api_configs' AND indexname = 'ix_upstream_api_configs_is_private_model'
    ) THEN
        CREATE INDEX ix_upstream_api_configs_is_private_model ON upstream_api_configs(is_private_model);
        RAISE NOTICE 'Created index ix_upstream_api_configs_is_private_model';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE tablename = 'upstream_api_configs' AND indexname = 'ix_upstream_api_configs_is_default_private_model'
    ) THEN
        CREATE INDEX ix_upstream_api_configs_is_default_private_model ON upstream_api_configs(is_default_private_model);
        RAISE NOTICE 'Created index ix_upstream_api_configs_is_default_private_model';
    END IF;
END $$;

-- Migration completed successfully
