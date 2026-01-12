-- Migration: Add application_settings table for fixed answer templates and other app-level settings
-- Version: 055
-- Description: Creates application_settings table to store application-level configurations like fixed answer templates

-- Create application_settings table
CREATE TABLE IF NOT EXISTS application_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,

    -- Fixed Answer Templates (stored as JSONB with language keys)
    -- Format: {"en": "English template", "zh": "中文模板"}
    security_risk_template JSONB DEFAULT '{"en": "Request blocked by OpenGuardrails due to possible violation of policy related to {scanner_name}.", "zh": "请求已被OpenGuardrails拦截，原因：可能违反了与{scanner_name}有关的策略要求。"}',
    data_leakage_template JSONB DEFAULT '{"en": "Request blocked by OpenGuardrails due to possible sensitive data ({entity_type_names}).", "zh": "请求已被OpenGuardrails拦截，原因：可能包含敏感数据（{entity_type_names}）。"}',

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Each application can only have one settings record
    CONSTRAINT uq_application_settings_app UNIQUE (application_id)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_application_settings_app_id ON application_settings(application_id);
CREATE INDEX IF NOT EXISTS idx_application_settings_tenant_id ON application_settings(tenant_id);

-- Add comment
COMMENT ON TABLE application_settings IS 'Application-level settings including fixed answer templates';
COMMENT ON COLUMN application_settings.security_risk_template IS 'Template for security risk responses, supports {scanner_name} placeholder';
COMMENT ON COLUMN application_settings.data_leakage_template IS 'Template for data leakage responses, supports {entity_type_names} placeholder';
