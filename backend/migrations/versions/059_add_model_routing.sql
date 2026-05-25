-- Migration: 059_add_model_routing
-- Description: Add model routing tables for automatic upstream API selection based on model name patterns
-- Created: 2026-01-25

-- model_routes table: stores routing rules for mapping model names to upstream APIs
CREATE TABLE IF NOT EXISTS model_routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    model_pattern VARCHAR(255) NOT NULL,  -- Model name pattern (e.g., "gpt-4", "claude")
    match_type VARCHAR(20) NOT NULL DEFAULT 'prefix',  -- 'exact' | 'prefix'
    upstream_api_config_id UUID NOT NULL REFERENCES upstream_api_configs(id) ON DELETE CASCADE,
    priority INTEGER NOT NULL DEFAULT 100,  -- Priority, higher number = higher priority
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_model_routes_tenant_pattern UNIQUE(tenant_id, model_pattern, match_type),
    CONSTRAINT chk_model_routes_match_type CHECK (match_type IN ('exact', 'prefix'))
);

-- Create indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_model_routes_tenant_id ON model_routes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_model_routes_active ON model_routes(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_model_routes_priority ON model_routes(priority DESC);

-- model_route_applications table: optional per-application route overrides
-- If a route has entries here, it only applies to those specific applications
-- If a route has no entries here, it applies to all applications (global route)
CREATE TABLE IF NOT EXISTS model_route_applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    model_route_id UUID NOT NULL REFERENCES model_routes(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_model_route_applications UNIQUE(model_route_id, application_id)
);

-- Create indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_model_route_applications_route_id ON model_route_applications(model_route_id);
CREATE INDEX IF NOT EXISTS idx_model_route_applications_app_id ON model_route_applications(application_id);

-- Add comment for documentation
COMMENT ON TABLE model_routes IS 'Model routing rules for automatic upstream API selection based on model name patterns';
COMMENT ON COLUMN model_routes.model_pattern IS 'Model name pattern to match (e.g., "gpt-4" for prefix match, "gpt-4-turbo" for exact match)';
COMMENT ON COLUMN model_routes.match_type IS 'Match type: exact for exact match, prefix for prefix match';
COMMENT ON COLUMN model_routes.priority IS 'Priority for route selection. Higher number = higher priority. Application-specific routes are checked before global routes.';
COMMENT ON TABLE model_route_applications IS 'Optional per-application route bindings. Routes without entries here apply to all applications.';
