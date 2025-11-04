-- Migration: Remove old tenant_id UNIQUE index from application-scoped tables
-- Description: After migration 011 added application management, tables should only
--              have UNIQUE constraints on application_id, not tenant_id.
--              This migration removes the obsolete tenant_id UNIQUE index.

-- RiskTypeConfig: Remove ix_risk_type_config_tenant_id UNIQUE index
-- Drop the unique index and recreate as a regular index for query performance
DROP INDEX IF EXISTS ix_risk_type_config_tenant_id;
CREATE INDEX IF NOT EXISTS ix_risk_type_config_tenant_id ON risk_type_config(tenant_id);

-- Verify application_id UNIQUE constraint exists (should have been added by migration 011)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_risk_type_config_application'
    ) THEN
        ALTER TABLE risk_type_config ADD CONSTRAINT uq_risk_type_config_application UNIQUE (application_id);
    END IF;
END$$;
