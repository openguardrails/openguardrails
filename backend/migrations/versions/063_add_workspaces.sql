-- Migration: Add workspaces table and workspace_id to applications
-- Description: Create workspaces as configuration templates that group applications

-- Create workspaces table
CREATE TABLE IF NOT EXISTS workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_workspaces_tenant_id ON workspaces(tenant_id);

-- Unique constraint: workspace name per tenant
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_workspaces_tenant_name') THEN
        ALTER TABLE workspaces ADD CONSTRAINT uq_workspaces_tenant_name UNIQUE (tenant_id, name);
    END IF;
END $$;

-- Add workspace_id to applications table
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'applications' AND column_name = 'workspace_id') THEN
        ALTER TABLE applications ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_applications_workspace_id ON applications(workspace_id);
