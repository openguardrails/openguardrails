-- Migration: 043_security_gateway_policy
-- Description: Add general risk policy, output risk actions, and private model names
-- Created: 2026-01-06

-- 1. Add output policy action fields (to match input policy structure)
-- Previously output policy only had boolean anonymize flags
ALTER TABLE tenant_data_leakage_policies
ADD COLUMN IF NOT EXISTS default_output_high_risk_action VARCHAR(50) DEFAULT 'block';

ALTER TABLE tenant_data_leakage_policies
ADD COLUMN IF NOT EXISTS default_output_medium_risk_action VARCHAR(50) DEFAULT 'anonymize';

ALTER TABLE tenant_data_leakage_policies
ADD COLUMN IF NOT EXISTS default_output_low_risk_action VARCHAR(50) DEFAULT 'pass';

ALTER TABLE application_data_leakage_policies
ADD COLUMN IF NOT EXISTS output_high_risk_action VARCHAR(50) DEFAULT NULL;

ALTER TABLE application_data_leakage_policies
ADD COLUMN IF NOT EXISTS output_medium_risk_action VARCHAR(50) DEFAULT NULL;

ALTER TABLE application_data_leakage_policies
ADD COLUMN IF NOT EXISTS output_low_risk_action VARCHAR(50) DEFAULT NULL;

-- 2. Add general risk policy fields (for security, safety, company policy violations)
-- Actions: 'block' | 'replace' (use knowledge base/template) | 'pass' (log only)
ALTER TABLE tenant_data_leakage_policies
ADD COLUMN IF NOT EXISTS default_general_high_risk_action VARCHAR(50) DEFAULT 'block';

ALTER TABLE tenant_data_leakage_policies
ADD COLUMN IF NOT EXISTS default_general_medium_risk_action VARCHAR(50) DEFAULT 'replace';

ALTER TABLE tenant_data_leakage_policies
ADD COLUMN IF NOT EXISTS default_general_low_risk_action VARCHAR(50) DEFAULT 'pass';

ALTER TABLE application_data_leakage_policies
ADD COLUMN IF NOT EXISTS general_high_risk_action VARCHAR(50) DEFAULT NULL;

ALTER TABLE application_data_leakage_policies
ADD COLUMN IF NOT EXISTS general_medium_risk_action VARCHAR(50) DEFAULT NULL;

ALTER TABLE application_data_leakage_policies
ADD COLUMN IF NOT EXISTS general_low_risk_action VARCHAR(50) DEFAULT NULL;

-- 3. Add private model names list to upstream_api_configs
-- This stores model names available for automatic switching when data leakage is detected
ALTER TABLE upstream_api_configs
ADD COLUMN IF NOT EXISTS private_model_names JSONB DEFAULT '[]'::jsonb;

-- Create index for faster private model queries
CREATE INDEX IF NOT EXISTS idx_upstream_api_configs_private_model
ON upstream_api_configs (tenant_id, is_private_model)
WHERE is_private_model = true;
