-- Migration: Redesign upstream API configurations for Security Gateway
-- Description: Replace per-model configuration with per-API configuration,
--              allowing one upstream API key to serve multiple models
-- Author: Claude
-- Date: 2025-10-31

-- ============================================================================
-- Step 1: Create new upstream_api_configs table
-- ============================================================================

CREATE TABLE IF NOT EXISTS upstream_api_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    config_name VARCHAR(100) NOT NULL,  -- Display name for UI (e.g., "OpenAI Production")
    api_base_url VARCHAR(512) NOT NULL,  -- Upstream API base URL
    api_key_encrypted TEXT NOT NULL,     -- Encrypted upstream API key
    provider VARCHAR(50),                 -- Provider type: openai, anthropic, local, etc.
    is_active BOOLEAN DEFAULT true,      -- Whether this config is active

    -- Security settings (moved from old table)
    block_on_input_risk BOOLEAN DEFAULT false,     -- Block requests with input risk
    block_on_output_risk BOOLEAN DEFAULT false,    -- Block responses with output risk
    enable_reasoning_detection BOOLEAN DEFAULT true, -- Detect reasoning content
    stream_chunk_size INTEGER DEFAULT 50,          -- Stream detection interval

    -- Metadata
    description TEXT,                    -- Optional description
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT upstream_api_configs_tenant_name_unique UNIQUE(tenant_id, config_name)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_upstream_api_configs_tenant_id ON upstream_api_configs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_upstream_api_configs_is_active ON upstream_api_configs(is_active);

-- ============================================================================
-- Step 2: Migrate existing data from proxy_model_configs to upstream_api_configs
-- ============================================================================

-- Group by tenant_id + api_base_url + api_key to consolidate duplicate API configs
INSERT INTO upstream_api_configs (
    id,
    tenant_id,
    config_name,
    api_base_url,
    api_key_encrypted,
    provider,
    is_active,
    block_on_input_risk,
    block_on_output_risk,
    enable_reasoning_detection,
    stream_chunk_size,
    description,
    created_at,
    updated_at
)
SELECT
    gen_random_uuid() as id,
    tenant_id,
    -- Use the first config_name as the display name, append "(Migrated)" to avoid conflicts
    MIN(config_name) || ' (Migrated)' as config_name,
    api_base_url,
    api_key_encrypted,
    -- Infer provider from api_base_url
    CASE
        WHEN api_base_url LIKE '%openai%' THEN 'openai'
        WHEN api_base_url LIKE '%anthropic%' THEN 'anthropic'
        WHEN api_base_url LIKE '%localhost%' OR api_base_url LIKE '%127.0.0.1%' THEN 'local'
        ELSE 'other'
    END as provider,
    BOOL_OR(enabled) as is_active,  -- Active if any old config was enabled
    BOOL_OR(block_on_input_risk) as block_on_input_risk,
    BOOL_OR(block_on_output_risk) as block_on_output_risk,
    BOOL_OR(enable_reasoning_detection) as enable_reasoning_detection,
    MAX(stream_chunk_size) as stream_chunk_size,
    'Migrated from proxy_model_configs. Original models: ' || STRING_AGG(model_name, ', ') as description,
    MIN(created_at) as created_at,
    MAX(updated_at) as updated_at
FROM proxy_model_configs
GROUP BY tenant_id, api_base_url, api_key_encrypted
ON CONFLICT (tenant_id, config_name) DO NOTHING;

-- ============================================================================
-- Step 3: Update proxy_request_logs to reference new table
-- ============================================================================

-- Add new column for upstream_api_config_id
ALTER TABLE proxy_request_logs
ADD COLUMN IF NOT EXISTS upstream_api_config_id UUID;

-- Create a mapping table to help migrate foreign keys
CREATE TEMP TABLE config_mapping AS
SELECT
    pmc.id as old_config_id,
    uac.id as new_config_id
FROM proxy_model_configs pmc
JOIN upstream_api_configs uac ON
    pmc.tenant_id = uac.tenant_id AND
    pmc.api_base_url = uac.api_base_url AND
    pmc.api_key_encrypted = uac.api_key_encrypted;

-- Update proxy_request_logs with new foreign keys
UPDATE proxy_request_logs prl
SET upstream_api_config_id = cm.new_config_id
FROM config_mapping cm
WHERE prl.proxy_config_id = cm.old_config_id;

-- Add foreign key constraint for new column
ALTER TABLE proxy_request_logs
ADD CONSTRAINT fk_proxy_request_logs_upstream_api_config
FOREIGN KEY (upstream_api_config_id) REFERENCES upstream_api_configs(id) ON DELETE SET NULL;

-- Create index for new foreign key
CREATE INDEX IF NOT EXISTS idx_proxy_request_logs_upstream_api_config_id
ON proxy_request_logs(upstream_api_config_id);

-- ============================================================================
-- Step 4: Mark old table as deprecated (keep for rollback, will drop in future)
-- ============================================================================

-- Rename old table to indicate deprecation
ALTER TABLE IF EXISTS proxy_model_configs
RENAME TO proxy_model_configs_deprecated;

-- Add comment to old table
COMMENT ON TABLE proxy_model_configs_deprecated IS
'DEPRECATED: Replaced by upstream_api_configs. Kept for rollback purposes. Will be dropped in future migration.';

-- Make old foreign key nullable for smooth transition
ALTER TABLE proxy_request_logs
ALTER COLUMN proxy_config_id DROP NOT NULL;

-- ============================================================================
-- Step 5: Add helpful comments
-- ============================================================================

COMMENT ON TABLE upstream_api_configs IS
'Upstream API configurations for Security Gateway. Each config represents one upstream API endpoint (e.g., OpenAI API) that can serve multiple models.';

COMMENT ON COLUMN upstream_api_configs.id IS
'UUID used in gateway URL: /v1/gateway/{id}/chat/completions';

COMMENT ON COLUMN upstream_api_configs.config_name IS
'Display name shown in UI, must be unique per tenant';

COMMENT ON COLUMN upstream_api_configs.api_base_url IS
'Upstream API base URL (e.g., https://api.openai.com/v1)';

COMMENT ON COLUMN upstream_api_configs.provider IS
'Provider type for UI display and special handling';

COMMENT ON COLUMN proxy_request_logs.upstream_api_config_id IS
'References the new upstream_api_configs table';

-- ============================================================================
-- Migration complete
-- ============================================================================
