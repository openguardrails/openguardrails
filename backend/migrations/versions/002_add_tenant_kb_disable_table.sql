-- Add tenant knowledge base disable table
-- This allows tenants to disable global knowledge bases for their own use

CREATE TABLE IF NOT EXISTS tenant_kb_disables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    kb_id INTEGER NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    disabled_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT tenant_kb_disable_unique UNIQUE (tenant_id, kb_id)
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_tenant_kb_disables_tenant_id ON tenant_kb_disables(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_kb_disables_kb_id ON tenant_kb_disables(kb_id);

COMMENT ON TABLE tenant_kb_disables IS 'Records which global knowledge bases are disabled for each tenant';
COMMENT ON COLUMN tenant_kb_disables.tenant_id IS 'Tenant who disabled the knowledge base';
COMMENT ON COLUMN tenant_kb_disables.kb_id IS 'Knowledge base that was disabled';
COMMENT ON COLUMN tenant_kb_disables.disabled_at IS 'When the knowledge base was disabled';
