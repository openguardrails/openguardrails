-- Migration: Add appeal system for false positive handling
-- Version: 049
-- Description: Creates appeal_config and appeal_records tables for user false positive appeals

-- 1. Create appeal_config table
CREATE TABLE IF NOT EXISTS appeal_config (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    -- Template for appeal link message, supports {appeal_url} placeholder
    message_template TEXT NOT NULL DEFAULT 'If you think this is a false positive, please click the following link to appeal: {appeal_url}',
    -- Base URL for appeal links (e.g., https://domain.com or http://192.168.1.100:5001)
    appeal_base_url VARCHAR(512) NOT NULL DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT uq_appeal_config_application UNIQUE (application_id)
);

-- 2. Create appeal_records table
CREATE TABLE IF NOT EXISTS appeal_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    request_id VARCHAR(64) NOT NULL,  -- Original detection request_id (guardrails-xxx)
    user_id VARCHAR(255),             -- User who triggered the detection

    -- Original detection info (denormalized for review)
    original_content TEXT NOT NULL,
    original_risk_level VARCHAR(20) NOT NULL,
    original_categories JSON NOT NULL,
    original_suggest_action VARCHAR(20) NOT NULL,

    -- Review status: pending, reviewing, approved, rejected
    status VARCHAR(20) NOT NULL DEFAULT 'pending',

    -- AI review results
    ai_review_result TEXT,            -- AI reasoning output
    ai_approved BOOLEAN,              -- AI decision: true=false positive confirmed
    ai_reviewed_at TIMESTAMP WITH TIME ZONE,

    -- Context for review
    user_recent_requests JSON,        -- Recent 10 requests from this user
    user_ban_history JSON,            -- User's ban records if any

    -- Whitelist addition
    whitelist_id INTEGER REFERENCES whitelist(id) ON DELETE SET NULL,
    whitelist_keyword TEXT,           -- The specific keyword/phrase added

    -- Metadata
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    CONSTRAINT uq_appeal_request_id UNIQUE (request_id)
);

-- 3. Create indexes
CREATE INDEX IF NOT EXISTS idx_appeal_config_application ON appeal_config(application_id);
CREATE INDEX IF NOT EXISTS idx_appeal_config_tenant ON appeal_config(tenant_id);

CREATE INDEX IF NOT EXISTS idx_appeal_records_application ON appeal_records(application_id);
CREATE INDEX IF NOT EXISTS idx_appeal_records_tenant ON appeal_records(tenant_id);
CREATE INDEX IF NOT EXISTS idx_appeal_records_status ON appeal_records(status);
CREATE INDEX IF NOT EXISTS idx_appeal_records_request_id ON appeal_records(request_id);
CREATE INDEX IF NOT EXISTS idx_appeal_records_user_id ON appeal_records(user_id);
CREATE INDEX IF NOT EXISTS idx_appeal_records_created_at ON appeal_records(created_at);

-- 4. Create trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_appeal_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_appeal_config_updated_at ON appeal_config;
CREATE TRIGGER trg_appeal_config_updated_at
    BEFORE UPDATE ON appeal_config
    FOR EACH ROW
    EXECUTE FUNCTION update_appeal_config_updated_at();

CREATE OR REPLACE FUNCTION update_appeal_records_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_appeal_records_updated_at ON appeal_records;
CREATE TRIGGER trg_appeal_records_updated_at
    BEFORE UPDATE ON appeal_records
    FOR EACH ROW
    EXECUTE FUNCTION update_appeal_records_updated_at();
