-- Fix proxy_model_configs foreign key constraint
-- The foreign key was incorrectly referencing 'users' table instead of 'tenants' table
--
-- Migration: 006_fix_proxy_model_configs_fk
-- Date: 2025-10-31
-- Description: Fix foreign key constraint on proxy_model_configs.tenant_id to reference tenants table

-- Drop the incorrect foreign key constraint if it exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_tables WHERE tablename = 'proxy_model_configs'
    ) THEN
        ALTER TABLE proxy_model_configs DROP CONSTRAINT IF EXISTS proxy_model_configs_user_id_fkey;
    END IF;
END $$;

-- Add the correct foreign key constraint (use IF NOT EXISTS equivalent with DO block)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'proxy_model_configs_tenant_id_fkey'
    ) and EXISTS (
        SELECT 1 FROM pg_tables WHERE tablename = 'proxy_model_configs'
    ) THEN
        ALTER TABLE proxy_model_configs ADD CONSTRAINT proxy_model_configs_tenant_id_fkey 
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;

-- Optionally, rename the index to match the new constraint name (if it exists)
ALTER INDEX IF EXISTS ix_proxy_model_configs_user_id RENAME TO ix_proxy_model_configs_tenant_id;

