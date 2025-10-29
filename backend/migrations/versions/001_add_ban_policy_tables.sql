-- Create ban policy tables
-- Run this script if ban policy tables are missing from the database

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

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_ban_policies_tenant ON ban_policies(tenant_id);
CREATE INDEX IF NOT EXISTS idx_user_ban_records_tenant_user ON user_ban_records(tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_user_ban_records_active ON user_ban_records(tenant_id, user_id, is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_user_risk_triggers_tenant_user_time ON user_risk_triggers(tenant_id, user_id, triggered_at);

-- Create triggers
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

-- Create utility functions
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

-- Add comments
COMMENT ON TABLE ban_policies IS 'Ban policy config table';
COMMENT ON TABLE user_ban_records IS 'User ban records table';
COMMENT ON TABLE user_risk_triggers IS 'User risk trigger history table';
