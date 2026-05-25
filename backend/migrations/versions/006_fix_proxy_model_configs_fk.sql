-- Fix proxy_model_configs foreign key constraint
-- The foreign key was incorrectly referencing 'users' table instead of 'tenants' table
--
-- Migration: 006_fix_proxy_model_configs_fk
-- Date: 2025-10-31
-- Description: Fix foreign key constraint on proxy_model_configs.tenant_id to reference tenants table
-- NOTE: This table was later renamed to proxy_model_configs_deprecated in migration 008

-- Only run if table exists (it may have been renamed/dropped in later migrations)
DO $$
BEGIN
    -- Check if table exists before attempting to modify it
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'proxy_model_configs'
    ) THEN
        -- Drop the incorrect foreign key constraint if it exists
        EXECUTE 'ALTER TABLE proxy_model_configs DROP CONSTRAINT IF EXISTS proxy_model_configs_user_id_fkey';

        -- Add the correct foreign key constraint if it doesn't exist
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'proxy_model_configs_tenant_id_fkey'
        ) THEN
            EXECUTE 'ALTER TABLE proxy_model_configs ADD CONSTRAINT proxy_model_configs_tenant_id_fkey
                FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE';
        END IF;

        -- Rename the index to match the new constraint name (if it exists)
        IF EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ix_proxy_model_configs_user_id') THEN
            EXECUTE 'ALTER INDEX ix_proxy_model_configs_user_id RENAME TO ix_proxy_model_configs_tenant_id';
        END IF;
    ELSE
        RAISE NOTICE 'Table proxy_model_configs does not exist, skipping migration 006';
    END IF;
END $$;

