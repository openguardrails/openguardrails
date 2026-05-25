-- Migration: 066_add_gateway_connections
-- Description: Add gateway_connections table for managing third-party gateway integrations (Higress, LiteLLM)

CREATE TABLE IF NOT EXISTS gateway_connections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    gateway_type VARCHAR(32) NOT NULL,
    is_enabled BOOLEAN NOT NULL DEFAULT false,
    config JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_gateway_connections_tenant_type UNIQUE(tenant_id, gateway_type)
);

CREATE INDEX IF NOT EXISTS idx_gateway_connections_tenant ON gateway_connections(tenant_id);
