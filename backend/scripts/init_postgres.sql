-- OpenGuardrails Platform - PostgreSQL database initialization script
-- Complete database schema with all migrations merged
-- Version: 2.3.0+
-- Last updated: 2025-10-20

-- Create necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- CORE TABLES
-- ============================================================

-- Tenants table (formerly users table)
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(128) NOT NULL,
    is_super_admin BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT FALSE,
    is_verified BOOLEAN DEFAULT FALSE,
    api_key VARCHAR(64) UNIQUE NOT NULL,
    language VARCHAR(10) DEFAULT 'en' NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Email verification table
CREATE TABLE IF NOT EXISTS email_verifications (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    verification_code VARCHAR(6) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    is_used BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Login attempts table (for anti-brute force)
CREATE TABLE IF NOT EXISTS login_attempts (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    ip_address VARCHAR(45) NOT NULL,
    user_agent TEXT,
    success BOOLEAN DEFAULT FALSE,
    attempted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- System config table
CREATE TABLE IF NOT EXISTS system_config (
    id SERIAL PRIMARY KEY,
    config_key VARCHAR(100) UNIQUE NOT NULL,
    config_value TEXT,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tenant switches table (for super admin to switch tenant perspective)
CREATE TABLE IF NOT EXISTS tenant_switches (
    id SERIAL PRIMARY KEY,
    admin_tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    target_tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    switch_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    session_token VARCHAR(128) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    is_active BOOLEAN DEFAULT TRUE
);

-- ============================================================
-- DETECTION AND SECURITY TABLES
-- ============================================================

-- Detection results table
CREATE TABLE IF NOT EXISTS detection_results (
    id SERIAL PRIMARY KEY,
    request_id VARCHAR(64) UNIQUE NOT NULL,
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    suggest_action VARCHAR(20) DEFAULT 'pass',
    suggest_answer TEXT,
    hit_keywords TEXT,
    model_response TEXT,
    ip_address VARCHAR(45),
    user_agent TEXT,
    -- Risk levels (English values with extended length)
    security_risk_level VARCHAR(20) DEFAULT 'no_risk',
    security_categories JSONB DEFAULT '[]',
    compliance_risk_level VARCHAR(20) DEFAULT 'no_risk',
    compliance_categories JSONB DEFAULT '[]',
    data_risk_level VARCHAR(20) DEFAULT 'no_risk',
    data_categories JSONB DEFAULT '[]',
    -- Confidence/Sensitivity fields
    confidence_level VARCHAR(10),
    confidence_score FLOAT,
    -- Multimodal fields
    has_image BOOLEAN DEFAULT FALSE,
    image_count INTEGER DEFAULT 0,
    image_paths JSONB DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Blacklist table
CREATE TABLE IF NOT EXISTS blacklist (
    id SERIAL PRIMARY KEY,
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    keywords JSONB NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Whitelist table
CREATE TABLE IF NOT EXISTS whitelist (
    id SERIAL PRIMARY KEY,
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    keywords JSONB NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Response templates table
CREATE TABLE IF NOT EXISTS response_templates (
    id SERIAL PRIMARY KEY,
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    category VARCHAR(50) NOT NULL,
    risk_level VARCHAR(20) NOT NULL,
    template_content TEXT NOT NULL,
    is_default BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Risk type config table
CREATE TABLE IF NOT EXISTS risk_type_config (
    id SERIAL PRIMARY KEY,
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE UNIQUE NOT NULL,
    -- S1-S12 risk type switches
    s1_enabled BOOLEAN DEFAULT TRUE,
    s2_enabled BOOLEAN DEFAULT TRUE,
    s3_enabled BOOLEAN DEFAULT TRUE,
    s4_enabled BOOLEAN DEFAULT TRUE,
    s5_enabled BOOLEAN DEFAULT TRUE,
    s6_enabled BOOLEAN DEFAULT TRUE,
    s7_enabled BOOLEAN DEFAULT TRUE,
    s8_enabled BOOLEAN DEFAULT TRUE,
    s9_enabled BOOLEAN DEFAULT TRUE,
    s10_enabled BOOLEAN DEFAULT TRUE,
    s11_enabled BOOLEAN DEFAULT TRUE,
    s12_enabled BOOLEAN DEFAULT TRUE,
    -- S1-S12 confidence thresholds
    s1_confidence_threshold FLOAT DEFAULT 0.90,
    s2_confidence_threshold FLOAT DEFAULT 0.90,
    s3_confidence_threshold FLOAT DEFAULT 0.90,
    s4_confidence_threshold FLOAT DEFAULT 0.90,
    s5_confidence_threshold FLOAT DEFAULT 0.90,
    s6_confidence_threshold FLOAT DEFAULT 0.90,
    s7_confidence_threshold FLOAT DEFAULT 0.90,
    s8_confidence_threshold FLOAT DEFAULT 0.90,
    s9_confidence_threshold FLOAT DEFAULT 0.90,
    s10_confidence_threshold FLOAT DEFAULT 0.90,
    s11_confidence_threshold FLOAT DEFAULT 0.90,
    s12_confidence_threshold FLOAT DEFAULT 0.90,
    -- Global sensitivity thresholds
    high_sensitivity_threshold FLOAT DEFAULT 0.40,
    medium_sensitivity_threshold FLOAT DEFAULT 0.60,
    low_sensitivity_threshold FLOAT DEFAULT 0.95,
    -- Sensitivity trigger level (low, medium, high)
    sensitivity_trigger_level VARCHAR(10) DEFAULT 'medium',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- DATA SECURITY TABLES
-- ============================================================

-- Data security entity types table
CREATE TABLE IF NOT EXISTS data_security_entity_types (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    entity_type VARCHAR(100) NOT NULL,
    entity_type_name VARCHAR(200) NOT NULL,
    category VARCHAR(50) NOT NULL,
    recognition_method VARCHAR(20) NOT NULL,
    recognition_config JSONB NOT NULL,
    anonymization_method VARCHAR(20) DEFAULT 'replace',
    anonymization_config JSONB,
    is_active BOOLEAN DEFAULT TRUE,
    is_global BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tenant entity type disables table
CREATE TABLE IF NOT EXISTS tenant_entity_type_disables (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    entity_type VARCHAR(100) NOT NULL,
    disabled_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(tenant_id, entity_type)
);

-- ============================================================
-- BAN POLICY TABLES
-- ============================================================

-- Ban policies table
CREATE TABLE IF NOT EXISTS ban_policies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    risk_level VARCHAR(20) NOT NULL DEFAULT 'high_risk',
    trigger_count INTEGER NOT NULL DEFAULT 3,
    time_window_minutes INTEGER NOT NULL DEFAULT 10,
    ban_duration_minutes INTEGER NOT NULL DEFAULT 60,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT check_risk_level CHECK (risk_level IN ('high_risk', 'medium_risk', 'low_risk')),
    CONSTRAINT check_trigger_count CHECK (trigger_count >= 1 AND trigger_count <= 100),
    CONSTRAINT check_time_window CHECK (time_window_minutes >= 1 AND time_window_minutes <= 1440),
    CONSTRAINT check_ban_duration CHECK (ban_duration_minutes >= 1 AND ban_duration_minutes <= 10080)
);

-- User ban records table
CREATE TABLE IF NOT EXISTS user_ban_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id VARCHAR(255) NOT NULL,
    banned_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    ban_until TIMESTAMP WITH TIME ZONE NOT NULL,
    trigger_count INTEGER NOT NULL,
    risk_level VARCHAR(20) NOT NULL,
    reason TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- User risk triggers table
CREATE TABLE IF NOT EXISTS user_risk_triggers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id VARCHAR(255) NOT NULL,
    detection_result_id VARCHAR(64),
    risk_level VARCHAR(20) NOT NULL,
    triggered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- RATE LIMITING TABLES
-- ============================================================

-- Tenant rate limits table
CREATE TABLE IF NOT EXISTS tenant_rate_limits (
    id SERIAL PRIMARY KEY,
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE UNIQUE NOT NULL,
    requests_per_second INTEGER DEFAULT 1 NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Tenant rate limit counters table
CREATE TABLE IF NOT EXISTS tenant_rate_limit_counters (
    tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    current_count INTEGER DEFAULT 0 NOT NULL,
    window_start TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
    last_updated TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
);

-- ============================================================
-- MODEL CONFIGURATION TABLES
-- ============================================================

-- Test model configs table
CREATE TABLE IF NOT EXISTS test_model_configs (
    id SERIAL PRIMARY KEY,
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    base_url VARCHAR(512) NOT NULL,
    api_key VARCHAR(512) NOT NULL,
    model_name VARCHAR(255) NOT NULL,
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Proxy model configs table (simplified design)
CREATE TABLE IF NOT EXISTS proxy_model_configs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    config_name VARCHAR(100) NOT NULL,
    api_base_url VARCHAR(512) NOT NULL,
    api_key_encrypted TEXT NOT NULL,
    model_name VARCHAR(255) NOT NULL,
    enabled BOOLEAN DEFAULT TRUE,
    -- Security config (simplified)
    enable_reasoning_detection BOOLEAN DEFAULT TRUE,
    -- Stream and confidence config
    stream_chunk_size INTEGER DEFAULT 50,
    confidence_trigger_level VARCHAR(10) DEFAULT 'medium',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT check_stream_chunk_size_range CHECK (stream_chunk_size >= 1 AND stream_chunk_size <= 500),
    CONSTRAINT check_confidence_trigger_level_values CHECK (confidence_trigger_level IN ('high', 'medium', 'low'))
);

-- Proxy request logs table
CREATE TABLE IF NOT EXISTS proxy_request_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    request_id VARCHAR(64) UNIQUE NOT NULL,
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    proxy_config_id UUID REFERENCES proxy_model_configs(id) ON DELETE CASCADE,
    -- Request information
    model_requested VARCHAR(255) NOT NULL,
    model_used VARCHAR(255) NOT NULL,
    provider VARCHAR(50) NOT NULL,
    -- Detection results
    input_detection_id VARCHAR(64),
    output_detection_id VARCHAR(64),
    input_blocked BOOLEAN DEFAULT FALSE,
    output_blocked BOOLEAN DEFAULT FALSE,
    -- Statistics
    request_tokens INTEGER,
    response_tokens INTEGER,
    total_tokens INTEGER,
    response_time_ms INTEGER,
    -- Status
    status VARCHAR(20) NOT NULL,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Online test model selections table
CREATE TABLE IF NOT EXISTS online_test_model_selections (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    proxy_model_id UUID REFERENCES proxy_model_configs(id) ON DELETE CASCADE,
    selected BOOLEAN DEFAULT FALSE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(tenant_id, proxy_model_id)
);

-- ============================================================
-- KNOWLEDGE BASE TABLES
-- ============================================================

-- Knowledge bases table
CREATE TABLE IF NOT EXISTS knowledge_bases (
    id SERIAL PRIMARY KEY,
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    category VARCHAR(50) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    file_path VARCHAR(512) NOT NULL,
    vector_file_path VARCHAR(512),
    total_qa_pairs INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    is_global BOOLEAN DEFAULT FALSE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================================
-- INDEXES
-- ============================================================

-- Tenants indexes
CREATE INDEX IF NOT EXISTS idx_tenants_email ON tenants(email);
CREATE INDEX IF NOT EXISTS idx_tenants_api_key ON tenants(api_key);

-- Email verifications indexes
CREATE INDEX IF NOT EXISTS idx_email_verifications_email ON email_verifications(email);

-- Login attempts indexes
CREATE INDEX IF NOT EXISTS idx_login_attempts_email ON login_attempts(email);
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip_address);
CREATE INDEX IF NOT EXISTS idx_login_attempts_success ON login_attempts(success);
CREATE INDEX IF NOT EXISTS idx_login_attempts_attempted_at ON login_attempts(attempted_at);

-- Detection results indexes
CREATE INDEX IF NOT EXISTS idx_detection_results_tenant_id ON detection_results(tenant_id);
CREATE INDEX IF NOT EXISTS idx_detection_results_request_id ON detection_results(request_id);
CREATE INDEX IF NOT EXISTS idx_detection_results_created_at ON detection_results(created_at);
CREATE INDEX IF NOT EXISTS idx_detection_results_has_image ON detection_results(has_image);

-- Blacklist indexes
CREATE INDEX IF NOT EXISTS idx_blacklist_tenant_id ON blacklist(tenant_id);
CREATE INDEX IF NOT EXISTS idx_blacklist_is_active ON blacklist(is_active);

-- Whitelist indexes
CREATE INDEX IF NOT EXISTS idx_whitelist_tenant_id ON whitelist(tenant_id);
CREATE INDEX IF NOT EXISTS idx_whitelist_is_active ON whitelist(is_active);

-- Response templates indexes
CREATE INDEX IF NOT EXISTS idx_response_templates_tenant_id ON response_templates(tenant_id);
CREATE INDEX IF NOT EXISTS idx_response_templates_category ON response_templates(category);

-- Risk type config indexes
CREATE INDEX IF NOT EXISTS idx_risk_type_config_tenant_id ON risk_type_config(tenant_id);

-- Data security entity types indexes
CREATE INDEX IF NOT EXISTS idx_data_security_entity_types_tenant_id ON data_security_entity_types(tenant_id);
CREATE INDEX IF NOT EXISTS idx_data_security_entity_types_entity_type ON data_security_entity_types(entity_type);
CREATE INDEX IF NOT EXISTS idx_data_security_entity_types_category ON data_security_entity_types(category);
CREATE INDEX IF NOT EXISTS idx_data_security_entity_types_is_active ON data_security_entity_types(is_active);
CREATE INDEX IF NOT EXISTS idx_data_security_entity_types_is_global ON data_security_entity_types(is_global);

-- Tenant entity type disables indexes
CREATE INDEX IF NOT EXISTS idx_tenant_entity_type_disables_tenant_id ON tenant_entity_type_disables(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_entity_type_disables_entity_type ON tenant_entity_type_disables(entity_type);

-- Ban policies indexes
CREATE INDEX IF NOT EXISTS idx_ban_policies_tenant ON ban_policies(tenant_id);

-- User ban records indexes
CREATE INDEX IF NOT EXISTS idx_user_ban_records_tenant_user ON user_ban_records(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_user_ban_records_active ON user_ban_records(tenant_id, user_id, is_active) WHERE is_active = TRUE;

-- User risk triggers indexes
CREATE INDEX IF NOT EXISTS idx_user_risk_triggers_tenant_user_time ON user_risk_triggers(tenant_id, user_id, triggered_at);

-- Tenant rate limits indexes
CREATE INDEX IF NOT EXISTS idx_tenant_rate_limits_tenant_id ON tenant_rate_limits(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_rate_limits_is_active ON tenant_rate_limits(is_active);

-- Test model configs indexes
CREATE INDEX IF NOT EXISTS idx_test_model_configs_tenant_id ON test_model_configs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_test_model_configs_enabled ON test_model_configs(enabled);

-- Proxy model configs indexes
CREATE INDEX IF NOT EXISTS idx_proxy_model_configs_tenant_id ON proxy_model_configs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_proxy_model_configs_config_name ON proxy_model_configs(config_name);
CREATE INDEX IF NOT EXISTS idx_proxy_model_configs_enabled ON proxy_model_configs(enabled);

-- Proxy request logs indexes
CREATE INDEX IF NOT EXISTS idx_proxy_request_logs_request_id ON proxy_request_logs(request_id);
CREATE INDEX IF NOT EXISTS idx_proxy_request_logs_tenant_id ON proxy_request_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_proxy_request_logs_input_detection_id ON proxy_request_logs(input_detection_id);
CREATE INDEX IF NOT EXISTS idx_proxy_request_logs_output_detection_id ON proxy_request_logs(output_detection_id);
CREATE INDEX IF NOT EXISTS idx_proxy_request_logs_created_at ON proxy_request_logs(created_at);

-- Online test model selections indexes
CREATE INDEX IF NOT EXISTS idx_online_test_model_selections_tenant_id ON online_test_model_selections(tenant_id);
CREATE INDEX IF NOT EXISTS idx_online_test_model_selections_proxy_model_id ON online_test_model_selections(proxy_model_id);

-- Knowledge bases indexes
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_tenant_id ON knowledge_bases(tenant_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_category ON knowledge_bases(category);
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_is_active ON knowledge_bases(is_active);
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_is_global ON knowledge_bases(is_global);

-- ============================================================
-- TRIGGERS AND FUNCTIONS
-- ============================================================

-- Update timestamp function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at columns
CREATE TRIGGER update_tenants_updated_at BEFORE UPDATE ON tenants
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_blacklist_updated_at BEFORE UPDATE ON blacklist
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_whitelist_updated_at BEFORE UPDATE ON whitelist
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_response_templates_updated_at BEFORE UPDATE ON response_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_risk_type_config_updated_at BEFORE UPDATE ON risk_type_config
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_tenant_rate_limits_updated_at BEFORE UPDATE ON tenant_rate_limits
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_test_model_configs_updated_at BEFORE UPDATE ON test_model_configs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_proxy_model_configs_updated_at BEFORE UPDATE ON proxy_model_configs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_knowledge_bases_updated_at BEFORE UPDATE ON knowledge_bases
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_data_security_entity_types_updated_at BEFORE UPDATE ON data_security_entity_types
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_tenant_entity_type_disables_updated_at BEFORE UPDATE ON tenant_entity_type_disables
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_online_test_model_selections_updated_at BEFORE UPDATE ON online_test_model_selections
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Ban policy triggers
CREATE OR REPLACE FUNCTION update_ban_policies_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ban_policies_updated_at
    BEFORE UPDATE ON ban_policies
    FOR EACH ROW
    EXECUTE FUNCTION update_ban_policies_updated_at();

CREATE OR REPLACE FUNCTION update_user_ban_records_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_ban_records_updated_at
    BEFORE UPDATE ON user_ban_records
    FOR EACH ROW
    EXECUTE FUNCTION update_user_ban_records_updated_at();

-- Ban policy utility functions
CREATE OR REPLACE FUNCTION deactivate_expired_bans()
RETURNS void AS $$
BEGIN
    UPDATE user_ban_records
    SET is_active = FALSE
    WHERE is_active = TRUE
    AND ban_until < NOW();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION cleanup_old_risk_triggers()
RETURNS void AS $$
BEGIN
    DELETE FROM user_risk_triggers
    WHERE triggered_at < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- DEFAULT DATA
-- ============================================================

-- Insert default admin tenant (password: admin123456)
INSERT INTO tenants (email, password_hash, is_super_admin, is_verified, is_active, api_key)
VALUES (
    'admin@openguardrails.com',
    '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewlDBqUJwgN3k6Nm',
    true,
    true,
    true,
    'sk-admin-' || substring(md5(random()::text) from 1 for 32)
)
ON CONFLICT (email) DO NOTHING;

-- Insert default response templates (English values)
INSERT INTO response_templates (tenant_id, category, risk_level, template_content, is_default, is_active)
VALUES
    (null, 'default', 'high_risk', 'I apologize, but I cannot answer your question. If you have other questions, I would be happy to help.', true, true),
    (null, 'default', 'medium_risk', 'I apologize, but I cannot provide relevant information. Let''s change the subject, I can introduce you to other interesting content.', true, true),
    (null, 'default', 'low_risk', 'Let''s maintain a friendly communication environment, I can provide you with other useful information.', true, true)
ON CONFLICT DO NOTHING;

-- ============================================================
-- COMMENTS
-- ============================================================

COMMENT ON TABLE tenants IS 'Tenant table (formerly users table)';
COMMENT ON TABLE email_verifications IS 'Email verification table';
COMMENT ON TABLE login_attempts IS 'Login attempt record table (for anti-brute force)';
COMMENT ON TABLE system_config IS 'System config table';
COMMENT ON TABLE tenant_switches IS 'Tenant switch record table (for super admin)';
COMMENT ON TABLE detection_results IS 'Detection results table';
COMMENT ON TABLE blacklist IS 'Blacklist table';
COMMENT ON TABLE whitelist IS 'Whitelist table';
COMMENT ON TABLE response_templates IS 'Response template table';
COMMENT ON TABLE risk_type_config IS 'Risk type switch config table';
COMMENT ON TABLE data_security_entity_types IS 'Data security entity type config table';
COMMENT ON TABLE tenant_entity_type_disables IS 'Tenant entity type disable table';
COMMENT ON TABLE ban_policies IS 'Ban policy config table';
COMMENT ON TABLE user_ban_records IS 'User ban records table';
COMMENT ON TABLE user_risk_triggers IS 'User risk trigger history table';
COMMENT ON TABLE tenant_rate_limits IS 'Tenant rate limit config table';
COMMENT ON TABLE tenant_rate_limit_counters IS 'Tenant real-time rate limit counter table';
COMMENT ON TABLE test_model_configs IS 'Test model config table';
COMMENT ON TABLE proxy_model_configs IS 'Reverse proxy model config table';
COMMENT ON TABLE proxy_request_logs IS 'Reverse proxy request log table';
COMMENT ON TABLE online_test_model_selections IS 'Online test model selection table';
COMMENT ON TABLE knowledge_bases IS 'Knowledge base table';

-- Column comments
COMMENT ON COLUMN tenants.language IS 'User language preference';
COMMENT ON COLUMN detection_results.has_image IS 'Whether contains image';
COMMENT ON COLUMN detection_results.image_count IS 'Image count';
COMMENT ON COLUMN detection_results.image_paths IS 'Saved image file path list';
COMMENT ON COLUMN detection_results.data_risk_level IS 'Data leakage risk level';
COMMENT ON COLUMN detection_results.data_categories IS 'Data leakage categories';
COMMENT ON COLUMN proxy_model_configs.enable_reasoning_detection IS 'Whether to detect reasoning content, default enabled';
COMMENT ON COLUMN proxy_model_configs.stream_chunk_size IS 'Stream detection interval, detect every N chunks, default 50';
COMMENT ON COLUMN proxy_model_configs.confidence_trigger_level IS 'Confidence trigger level: high, medium, low';
COMMENT ON COLUMN tenant_entity_type_disables.entity_type IS 'Disabled entity type code';
COMMENT ON COLUMN knowledge_bases.is_global IS 'Whether it is a global knowledge base (all tenants take effect), only admin can set';

-- Completion message
DO $$
BEGIN
    RAISE NOTICE '========================================';
    RAISE NOTICE 'OpenGuardrails database initialization completed successfully!';
    RAISE NOTICE 'All tables, indexes, triggers, and default data have been created.';
    RAISE NOTICE 'Default admin account: admin@openguardrails.com';
    RAISE NOTICE 'Default password: admin123456';
    RAISE NOTICE '========================================';
END $$;
