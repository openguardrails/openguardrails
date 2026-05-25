-- Migration: 067_add_team_members
-- Description: Add tenant_members and tenant_invitations tables for team management with RBAC

-- Table: tenant_members - Maps users to tenant organizations with roles
CREATE TABLE IF NOT EXISTS tenant_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'member',
    invite_status VARCHAR(20) NOT NULL DEFAULT 'pending',
    invited_by UUID REFERENCES tenants(id),
    invited_at TIMESTAMPTZ DEFAULT NOW(),
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_members_tenant_id ON tenant_members(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_members_user_id ON tenant_members(user_id);
CREATE INDEX IF NOT EXISTS idx_tenant_members_email ON tenant_members(email);

-- Each user can only belong to one organization
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_tenant_members_user_id') THEN
        ALTER TABLE tenant_members ADD CONSTRAINT uq_tenant_members_user_id UNIQUE (user_id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_tenant_members_tenant_user') THEN
        ALTER TABLE tenant_members ADD CONSTRAINT uq_tenant_members_tenant_user UNIQUE (tenant_id, user_id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uq_tenant_member_email') THEN
        ALTER TABLE tenant_members ADD CONSTRAINT uq_tenant_member_email UNIQUE (tenant_id, email);
    END IF;
END $$;

-- Table: tenant_invitations - Pending invitations (token-based)
CREATE TABLE IF NOT EXISTS tenant_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'member',
    invited_by UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    invitation_token VARCHAR(128) NOT NULL UNIQUE,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_invitations_tenant_id ON tenant_invitations(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_invitations_email ON tenant_invitations(email);
CREATE INDEX IF NOT EXISTS idx_tenant_invitations_token ON tenant_invitations(invitation_token);

-- Prevent duplicate pending invitations for same email in same tenant
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_invitations_pending_unique
    ON tenant_invitations(tenant_id, email) WHERE status = 'pending';

-- Migrate existing data: Every existing tenant becomes owner of their own organization
INSERT INTO tenant_members (id, tenant_id, user_id, email, role, invite_status, accepted_at)
SELECT gen_random_uuid(), t.id, t.id, t.email, 'owner', 'accepted', t.created_at
FROM tenants t
WHERE NOT EXISTS (
    SELECT 1 FROM tenant_members WHERE tenant_members.user_id = t.id
);
