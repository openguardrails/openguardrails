-- Migration: 087_add_created_by_tenant_id
-- Description: Add created_by_tenant_id to tenants table to distinguish independent tenants from sub-users
-- Independent tenants (self-registered): created_by_tenant_id IS NULL
-- Sub-users (created by super admin): created_by_tenant_id = super admin's tenant ID

-- Add created_by_tenant_id column
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS created_by_tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL;

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_tenants_created_by_tenant_id ON tenants(created_by_tenant_id);

-- Add comment
COMMENT ON COLUMN tenants.created_by_tenant_id IS 'ID of the tenant who created this user. NULL means independent tenant (self-registered).';

-- For private deployment: Mark all existing non-super-admin users as sub-users created by super admin
-- Super admin is identified by email from .env (default: admin@yourdomain.com)
UPDATE tenants
SET created_by_tenant_id = (SELECT id FROM tenants WHERE email = 'admin@yourdomain.com' LIMIT 1)
WHERE email != 'admin@yourdomain.com'
  AND created_by_tenant_id IS NULL
  AND EXISTS (SELECT 1 FROM tenants WHERE email = 'admin@yourdomain.com');
