-- Migration: data_leakage_refactor
-- Version: 038
-- Date: 2026-01-05
-- Author: Claude

-- Description:
-- Major refactoring of data leakage prevention system:
-- 1. Add safe model fields to upstream_api_configs (is_data_safe, is_default_safe_model, safe_model_priority)
-- 2. Create application_data_leakage_policies table for application-level disposal strategies
-- 3. Enable smart model switching, anonymization, and blocking based on data leakage risk

-- ============================================================================
-- Part 1: Add safe model fields to upstream_api_configs
-- ============================================================================

ALTER TABLE upstream_api_configs ADD COLUMN IF NOT EXISTS is_data_safe BOOLEAN DEFAULT FALSE;
ALTER TABLE upstream_api_configs ADD COLUMN IF NOT EXISTS is_default_safe_model BOOLEAN DEFAULT FALSE;
ALTER TABLE upstream_api_configs ADD COLUMN IF NOT EXISTS safe_model_priority INTEGER DEFAULT 0;

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_upstream_api_configs_is_data_safe ON upstream_api_configs(is_data_safe);
CREATE INDEX IF NOT EXISTS idx_upstream_api_configs_is_default_safe_model ON upstream_api_configs(is_default_safe_model);

-- ============================================================================
-- Part 2: Create application_data_leakage_policies table
-- ============================================================================

-- Create table with DEFAULT gen_random_uuid() for id column
CREATE TABLE IF NOT EXISTS application_data_leakage_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,

    -- Disposal actions for each risk level: 'block' | 'switch_safe_model' | 'anonymize' | 'pass'
    high_risk_action VARCHAR(50) NOT NULL DEFAULT 'block',
    medium_risk_action VARCHAR(50) NOT NULL DEFAULT 'switch_safe_model',
    low_risk_action VARCHAR(50) NOT NULL DEFAULT 'anonymize',

    -- Safe model configuration (nullable if using tenant's default)
    safe_model_id UUID REFERENCES upstream_api_configs(id) ON DELETE SET NULL,

    -- Feature flags
    enable_format_detection BOOLEAN NOT NULL DEFAULT TRUE,
    enable_smart_segmentation BOOLEAN NOT NULL DEFAULT TRUE,

    -- Timestamps
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    -- Constraints
    CONSTRAINT uq_application_data_leakage_policy UNIQUE (application_id)
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_application_data_leakage_policies_tenant
ON application_data_leakage_policies(tenant_id);

CREATE INDEX IF NOT EXISTS idx_application_data_leakage_policies_app
ON application_data_leakage_policies(application_id);

-- ============================================================================
-- Part 3: Create default policies for all existing applications
-- ============================================================================

-- Create default policies for all existing applications
-- Default strategy: high=block, medium=switch_safe_model, low=anonymize
-- Use WHERE NOT EXISTS to handle re-runs and partial failures
INSERT INTO application_data_leakage_policies (
    tenant_id,
    application_id,
    high_risk_action,
    medium_risk_action,
    low_risk_action,
    enable_format_detection,
    enable_smart_segmentation
)
SELECT
    a.tenant_id,
    a.id,
    'block',
    'switch_safe_model',
    'anonymize',
    TRUE,
    TRUE
FROM applications a
WHERE NOT EXISTS (
    SELECT 1 FROM application_data_leakage_policies p WHERE p.application_id = a.id
);