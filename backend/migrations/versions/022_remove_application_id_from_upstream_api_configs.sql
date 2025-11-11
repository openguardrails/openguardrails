-- Migration: remove_application_id_from_upstream_api_configs
-- Version: 022
-- Date: 2025-11-11
-- Author: Auto-generated

-- Description:
-- Remove application_id from upstream_api_configs table.
-- Security Gateway configurations are tenant-level and should not be tied to any application.
-- Applications are determined by the API key used when calling the gateway, not by the config itself.

-- ============================================================================
-- Step 1: Drop the application_id unique constraint if it exists
-- ============================================================================

-- Drop the unique constraint on (application_id, config_name) if it exists
ALTER TABLE upstream_api_configs 
DROP CONSTRAINT IF EXISTS upstream_api_configs_application_name_unique;

-- ============================================================================
-- Step 2: Drop the foreign key constraint (must be done before making nullable)
-- ============================================================================

ALTER TABLE upstream_api_configs
DROP CONSTRAINT IF EXISTS upstream_api_configs_application_id_fkey;

-- ============================================================================
-- Step 3: Make application_id nullable (must be done before setting to NULL)
-- ============================================================================

ALTER TABLE upstream_api_configs
ALTER COLUMN application_id DROP NOT NULL;

-- ============================================================================
-- Step 4: Set all existing application_id values to NULL
-- ============================================================================

UPDATE upstream_api_configs
SET application_id = NULL;

-- ============================================================================
-- Step 5: Drop the index on application_id
-- ============================================================================

DROP INDEX IF EXISTS idx_upstream_api_configs_application_id;

-- ============================================================================
-- Step 6: Verify tenant_id + config_name unique constraint exists
-- ============================================================================

-- The constraint upstream_api_configs_tenant_name_unique should already exist from migration 008
-- If it doesn't exist, create it
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'upstream_api_configs_tenant_name_unique'
        AND conrelid = 'upstream_api_configs'::regclass
    ) THEN
        ALTER TABLE upstream_api_configs
        ADD CONSTRAINT upstream_api_configs_tenant_name_unique UNIQUE(tenant_id, config_name);
    END IF;
END $$;

-- ============================================================================
-- Step 7: Add helpful comment
-- ============================================================================

COMMENT ON COLUMN upstream_api_configs.application_id IS
'DEPRECATED: Security Gateway configurations are tenant-level and do not belong to any application. This column is kept for backward compatibility but should always be NULL. Applications are determined by the API key used when calling the gateway.';

COMMENT ON TABLE upstream_api_configs IS
'Upstream API configurations for Security Gateway. These are tenant-level configurations that are shared across all applications. The application context is determined by the API key used when calling the gateway endpoint.';

-- ============================================================================
-- Migration complete
-- ============================================================================

