-- Migration: Remove old ix_risk_type_config_user_id unique constraint
-- Description: This migration removes the obsolete unique constraint/index
--              named "ix_risk_type_config_user_id" that was created on tenant_id.
--              This constraint was preventing multiple applications under the same
--              tenant from having their own risk_type_config records.
--              The correct constraint should be on application_id only (added in migration 011).

-- Drop the old unique index/constraint if it exists
-- Note: PostgreSQL might have created this as either an index or a constraint
DO $$
DECLARE
    r RECORD;
BEGIN
    -- Try to drop as a unique index first
    IF EXISTS (
        SELECT 1 FROM pg_indexes 
        WHERE indexname = 'ix_risk_type_config_user_id'
    ) THEN
        DROP INDEX IF EXISTS ix_risk_type_config_user_id;
        RAISE NOTICE 'Dropped index ix_risk_type_config_user_id';
    END IF;

    -- Also check for constraint with similar name (in case it was created as a constraint)
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'ix_risk_type_config_user_id'
    ) THEN
        ALTER TABLE risk_type_config DROP CONSTRAINT IF EXISTS ix_risk_type_config_user_id;
        RAISE NOTICE 'Dropped constraint ix_risk_type_config_user_id';
    END IF;

    -- Also check for any other unique constraints on tenant_id that might exist
    -- (excluding the one we want to keep for query performance)
    -- Use a simpler approach: check if constraint involves tenant_id column
    FOR r IN (
        SELECT conname 
        FROM pg_constraint c
        WHERE conrelid = 'risk_type_config'::regclass
        AND contype = 'u'
        AND conname != 'uq_risk_type_config_application'
        AND EXISTS (
            SELECT 1 
            FROM unnest(c.conkey) AS col_num
            JOIN pg_attribute a ON a.attrelid = 'risk_type_config'::regclass
                AND a.attnum = col_num
            WHERE a.attname = 'tenant_id'
        )
    ) LOOP
        EXECUTE format('ALTER TABLE risk_type_config DROP CONSTRAINT IF EXISTS %I', r.conname);
        RAISE NOTICE 'Dropped unique constraint: %', r.conname;
    END LOOP;
END $$;

-- Ensure tenant_id has a regular (non-unique) index for query performance
CREATE INDEX IF NOT EXISTS ix_risk_type_config_tenant_id ON risk_type_config(tenant_id);

-- Verify application_id UNIQUE constraint exists (should have been added by migration 011)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_risk_type_config_application'
        AND conrelid = 'risk_type_config'::regclass
    ) THEN
        ALTER TABLE risk_type_config ADD CONSTRAINT uq_risk_type_config_application UNIQUE (application_id);
        RAISE NOTICE 'Added uq_risk_type_config_application constraint';
    END IF;
END $$;

