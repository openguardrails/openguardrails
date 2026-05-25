-- Migration: Add workspace_id to appeal_config for workspace-level appeal configuration
-- This allows appeal config to be set at workspace level, following the same pattern as other configs

-- Make application_id nullable (workspace-level configs have no application_id)
ALTER TABLE appeal_config ALTER COLUMN application_id DROP NOT NULL;

-- Add workspace_id column
ALTER TABLE appeal_config ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;

-- Create index for workspace_id
CREATE INDEX IF NOT EXISTS idx_appeal_config_workspace_id ON appeal_config(workspace_id);

-- Add unique constraint for workspace-level config (one config per workspace, application_id is NULL)
ALTER TABLE appeal_config DROP CONSTRAINT IF EXISTS uq_appeal_config_workspace;
CREATE UNIQUE INDEX IF NOT EXISTS uq_appeal_config_workspace ON appeal_config(workspace_id) WHERE workspace_id IS NOT NULL AND application_id IS NULL;
