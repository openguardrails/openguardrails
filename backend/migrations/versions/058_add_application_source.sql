-- Migration: Add source and external_id columns to applications table
-- Purpose: Support automatic application discovery from third-party gateways (e.g., Higress)
-- When using tenant API key with consumer header, OG can auto-create applications

-- Add source column to track how the application was created
-- 'manual' - Created manually via UI or API
-- 'auto_discovery' - Auto-created from gateway consumer
ALTER TABLE applications ADD COLUMN IF NOT EXISTS source VARCHAR(32) DEFAULT 'manual';

-- Add external_id column to store the external identifier (e.g., gateway consumer name)
-- This is used to match incoming requests to existing applications
ALTER TABLE applications ADD COLUMN IF NOT EXISTS external_id VARCHAR(255);

-- Create index for fast lookup by external_id
-- This is critical for performance as every request with consumer header needs this lookup
CREATE INDEX IF NOT EXISTS idx_applications_external_id
ON applications(tenant_id, external_id)
WHERE external_id IS NOT NULL;

-- Update existing applications to explicitly have source='manual'
-- This ensures backward compatibility - all existing apps are manually created
UPDATE applications SET source = 'manual' WHERE source IS NULL;

-- Add comment for documentation
COMMENT ON COLUMN applications.source IS 'How the application was created: manual (UI/API) or auto_discovery (gateway consumer)';
COMMENT ON COLUMN applications.external_id IS 'External identifier for auto-discovered apps (e.g., gateway consumer name)';
