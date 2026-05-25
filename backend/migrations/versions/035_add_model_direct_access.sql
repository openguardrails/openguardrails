-- Migration: add_model_direct_access
-- Version: 035
-- Date: 2025-12-17
-- Author: OpenGuardrails Team

-- Description:
-- Add direct model access feature that allows tenants to directly call models
-- (guardrails-text, bge-m3, future vision models) using OpenAI-compatible API.
-- This feature is designed for private deployment where tenants want to self-host
-- the platform but use cloud-hosted models. For privacy, we only track usage count,
-- not the actual content.

-- ============================================================================
-- STEP 1: Add model_api_key column to tenants table
-- ============================================================================

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS model_api_key VARCHAR(64) UNIQUE;

COMMENT ON COLUMN tenants.model_api_key IS 'API key for direct model access (format: sk-xxai-model-{52 chars}). Used to call models directly without guardrails detection. Content is not logged, only usage count for billing.';

-- Create index for fast lookup
CREATE INDEX IF NOT EXISTS idx_tenants_model_api_key ON tenants(model_api_key);

-- ============================================================================
-- STEP 2: Create model_usage table for tracking usage (count only, no content)
-- ============================================================================

CREATE TABLE IF NOT EXISTS model_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    model_name VARCHAR(100) NOT NULL,
    -- Usage metrics (no content stored for privacy)
    request_count INTEGER DEFAULT 1 NOT NULL,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

    -- Track daily usage per model
    usage_date DATE DEFAULT CURRENT_DATE NOT NULL
);

-- Ensure default is set even if table already exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'model_usage' AND column_name = 'id'
               AND column_default IS NULL) THEN
        ALTER TABLE model_usage ALTER COLUMN id SET DEFAULT gen_random_uuid();
    END IF;
END $$;

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_model_usage_tenant_id ON model_usage(tenant_id);
CREATE INDEX IF NOT EXISTS idx_model_usage_model_name ON model_usage(model_name);
CREATE INDEX IF NOT EXISTS idx_model_usage_usage_date ON model_usage(usage_date);
CREATE INDEX IF NOT EXISTS idx_model_usage_created_at ON model_usage(created_at);

-- Unique constraint: one record per tenant per model per day
CREATE UNIQUE INDEX IF NOT EXISTS uq_model_usage_tenant_model_date
    ON model_usage(tenant_id, model_name, usage_date);

COMMENT ON TABLE model_usage IS 'Tracks direct model access usage for billing. PRIVACY: Only stores counts and tokens, never stores actual content.';
COMMENT ON COLUMN model_usage.tenant_id IS 'Tenant who made the request';
COMMENT ON COLUMN model_usage.model_name IS 'Model used (OpenGuardrails-Text, bge-m3, etc.)';
COMMENT ON COLUMN model_usage.request_count IS 'Number of requests made';
COMMENT ON COLUMN model_usage.input_tokens IS 'Total input tokens used';
COMMENT ON COLUMN model_usage.output_tokens IS 'Total output tokens generated';
COMMENT ON COLUMN model_usage.total_tokens IS 'Total tokens (input + output)';
COMMENT ON COLUMN model_usage.usage_date IS 'Date of usage (for daily aggregation)';

-- ============================================================================
-- STEP 3: Generate model_api_key for all existing tenants
-- ============================================================================

DO $$
DECLARE
    tenant_record RECORD;
    new_model_key VARCHAR(64);
BEGIN
    FOR tenant_record IN SELECT id, email FROM tenants WHERE model_api_key IS NULL LOOP
        -- Generate new model API key: sk-xxai-model-{52 random chars}
        -- Use pgcrypto extension if available, fallback to random()
        BEGIN
            -- Try using gen_random_bytes from pgcrypto extension
            new_model_key := 'sk-xxai-model-' || encode(gen_random_bytes(39), 'hex');
        EXCEPTION WHEN OTHERS THEN
            -- Fallback: use random() with md5 for older PostgreSQL versions
            new_model_key := 'sk-xxai-model-' || md5(extract(epoch from now())::text || random()::text || tenant_record.id::text);
        END;

        -- Update tenant with new model API key
        UPDATE tenants
        SET model_api_key = new_model_key
        WHERE id = tenant_record.id;

        RAISE NOTICE 'Generated model API key for tenant % (email: %)', tenant_record.id, tenant_record.email;
    END LOOP;
END $$;

-- ============================================================================
-- STEP 4: Verification queries (for logging)
-- ============================================================================

DO $$
DECLARE
    tenant_count INT;
    key_count INT;
BEGIN
    SELECT COUNT(*) INTO tenant_count FROM tenants;
    SELECT COUNT(*) INTO key_count FROM tenants WHERE model_api_key IS NOT NULL;

    RAISE NOTICE '=== Migration 035 Complete ===';
    RAISE NOTICE 'Total tenants: %', tenant_count;
    RAISE NOTICE 'Tenants with model API keys: %', key_count;
    RAISE NOTICE 'Created model_usage table for privacy-preserving usage tracking';
    RAISE NOTICE '================================';
END $$;
