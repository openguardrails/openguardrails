-- Migration: Add application_id to tenant_entity_type_disables
-- Description: Add application_id column to support application-level entity type disabling
-- Version: 046

-- Add application_id column to tenant_entity_type_disables table
ALTER TABLE tenant_entity_type_disables
ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES applications(id);

-- Create index for application_id
CREATE INDEX IF NOT EXISTS idx_tenant_entity_type_disables_application_id
ON tenant_entity_type_disables(application_id);

-- Drop old unique constraint if exists
ALTER TABLE tenant_entity_type_disables
DROP CONSTRAINT IF EXISTS _tenant_entity_type_disable_uc;

-- Create new unique constraint that includes application_id
-- Using COALESCE to handle NULL application_id values properly
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = '_tenant_app_entity_type_disable_uc'
    ) THEN
        ALTER TABLE tenant_entity_type_disables
        ADD CONSTRAINT _tenant_app_entity_type_disable_uc
        UNIQUE (tenant_id, application_id, entity_type);
    END IF;
END $$;
