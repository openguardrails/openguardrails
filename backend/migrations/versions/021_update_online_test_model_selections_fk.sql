-- Migration: update_online_test_model_selections_fk
-- Version: 021
-- Date: 2025-01-XX
-- Author: Auto-generated

-- Description:
-- Update online_test_model_selections table to reference upstream_api_configs
-- instead of proxy_model_configs_deprecated. This fixes the issue where new
-- configurations added in the security gateway don't appear in the online test
-- page, and prevents foreign key violations when enabling models.

-- ============================================================================
-- Step 1: Drop old foreign key constraint
-- ============================================================================

-- Drop the old foreign key constraint if it exists
ALTER TABLE online_test_model_selections 
DROP CONSTRAINT IF EXISTS online_test_model_selections_proxy_model_id_fkey;

-- ============================================================================
-- Step 2: Clean up orphaned records (optional but recommended)
-- ============================================================================

-- Delete any selections that reference models in the deprecated table
-- that don't have a corresponding entry in upstream_api_configs
-- (This is safe because users can re-select their models after migration)
DELETE FROM online_test_model_selections oms
WHERE NOT EXISTS (
    SELECT 1 FROM upstream_api_configs uac 
    WHERE uac.id = oms.proxy_model_id
);

-- ============================================================================
-- Step 3: Add new foreign key constraint
-- ============================================================================

-- Add the new foreign key constraint pointing to upstream_api_configs
ALTER TABLE online_test_model_selections
ADD CONSTRAINT online_test_model_selections_proxy_model_id_fkey
FOREIGN KEY (proxy_model_id) REFERENCES upstream_api_configs(id) ON DELETE CASCADE;

-- ============================================================================
-- Step 4: Add helpful comment
-- ============================================================================

COMMENT ON COLUMN online_test_model_selections.proxy_model_id IS
'References upstream_api_configs.id (migrated from proxy_model_configs_deprecated)';

-- ============================================================================
-- Migration complete
-- ============================================================================

