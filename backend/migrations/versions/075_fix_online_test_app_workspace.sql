-- Migration: Fix Online Test applications missing workspace_id
-- Description: Assign existing Online Test applications to their tenant's global workspace
-- Version: 075
-- Date: 2026-03-31

-- Update Online Test apps that have no workspace_id to use the tenant's global workspace
UPDATE applications
SET workspace_id = w.id
FROM workspaces w
WHERE applications.source = 'online_test'
  AND applications.workspace_id IS NULL
  AND w.tenant_id = applications.tenant_id
  AND w.is_global = TRUE;
