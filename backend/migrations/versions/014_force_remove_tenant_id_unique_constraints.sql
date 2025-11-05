-- Migration: Force remove all unique constraints on tenant_id in risk_type_config
-- Version: 014
-- Date: 2025-11-05
-- Author: System

-- Description:
-- This migration forcefully removes any remaining unique constraints or indexes
-- on tenant_id in the risk_type_config table. The error "ix_risk_type_config_user_id"
-- indicates that an old constraint still exists, preventing multiple applications
-- under the same tenant from having their own risk_type_config records.
--
-- The correct constraint should be on application_id only (enforced by uq_risk_type_config_application).

-- Step 1: Drop ALL unique constraints on tenant_id in risk_type_config
-- This includes any constraint with any name that enforces uniqueness on tenant_id
DO $$
DECLARE
    constraint_record RECORD;
    index_record RECORD;
BEGIN
    -- Find and drop all unique constraints on tenant_id
    FOR constraint_record IN
        SELECT conname, conkey
        FROM pg_constraint
        WHERE conrelid = 'risk_type_config'::regclass
        AND contype = 'u'  -- Unique constraint
        AND (
            -- Check if tenant_id is in the constraint columns
            array_length(ARRAY(SELECT unnest(conkey)::int), 1) = 1
            AND (SELECT attname FROM pg_attribute WHERE attrelid = 'risk_type_config'::regclass AND attnum = (SELECT unnest(conkey)::int)) = 'tenant_id'
            OR
            -- Check all columns in the constraint
            EXISTS (
                SELECT 1 FROM unnest(conkey) AS col_num
                JOIN pg_attribute ON pg_attribute.attrelid = 'risk_type_config'::regclass
                AND pg_attribute.attnum = col_num
                WHERE pg_attribute.attname = 'tenant_id'
            )
        )
    LOOP
        EXECUTE format('ALTER TABLE risk_type_config DROP CONSTRAINT IF EXISTS %I', constraint_record.conname);
        RAISE NOTICE 'Dropped unique constraint: %', constraint_record.conname;
    END LOOP;

    -- Find and drop all unique indexes on tenant_id
    FOR index_record IN
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'risk_type_config'
        AND indexdef LIKE '%UNIQUE%'
        AND (
            indexdef LIKE '%tenant_id%'
            OR indexname LIKE '%tenant_id%'
            OR indexname LIKE '%user_id%'  -- Also catch old "user_id" named indexes
        )
    LOOP
        EXECUTE format('DROP INDEX IF EXISTS %I', index_record.indexname);
        RAISE NOTICE 'Dropped unique index: %', index_record.indexname;
    END LOOP;

    -- Specifically target the problematic constraint name from the error
    DROP INDEX IF EXISTS ix_risk_type_config_user_id;
    ALTER TABLE risk_type_config DROP CONSTRAINT IF EXISTS ix_risk_type_config_user_id;
    
    RAISE NOTICE 'Completed cleanup of tenant_id unique constraints';
END $$;

-- Step 2: Ensure we have a regular (non-unique) index on tenant_id for query performance
CREATE INDEX IF NOT EXISTS ix_risk_type_config_tenant_id ON risk_type_config(tenant_id);

-- Step 3: Ensure application_id UNIQUE constraint exists (this is the correct constraint)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_risk_type_config_application'
        AND conrelid = 'risk_type_config'::regclass
    ) THEN
        ALTER TABLE risk_type_config ADD CONSTRAINT uq_risk_type_config_application UNIQUE (application_id);
        RAISE NOTICE 'Added uq_risk_type_config_application constraint';
    ELSE
        RAISE NOTICE 'uq_risk_type_config_application constraint already exists';
    END IF;
END $$;

-- Step 4: Verify the final state
DO $$
DECLARE
    unique_constraints_count INTEGER;
    tenant_id_unique_count INTEGER;
BEGIN
    -- Count all unique constraints
    SELECT COUNT(*) INTO unique_constraints_count
    FROM pg_constraint
    WHERE conrelid = 'risk_type_config'::regclass
    AND contype = 'u';

    -- Count unique constraints involving tenant_id
    SELECT COUNT(*) INTO tenant_id_unique_count
    FROM pg_constraint
    WHERE conrelid = 'risk_type_config'::regclass
    AND contype = 'u'
    AND EXISTS (
        SELECT 1 FROM unnest(conkey) AS col_num
        JOIN pg_attribute ON pg_attribute.attrelid = 'risk_type_config'::regclass
        AND pg_attribute.attnum = col_num
        WHERE pg_attribute.attname = 'tenant_id'
    );

    IF tenant_id_unique_count > 0 THEN
        RAISE WARNING 'WARNING: Found % unique constraint(s) on tenant_id. This may cause issues.', tenant_id_unique_count;
    ELSE
        RAISE NOTICE 'SUCCESS: No unique constraints found on tenant_id';
    END IF;

    IF unique_constraints_count = 1 THEN
        RAISE NOTICE 'SUCCESS: Found exactly 1 unique constraint (should be on application_id)';
    ELSE
        RAISE WARNING 'WARNING: Found % unique constraint(s) (expected 1 on application_id)', unique_constraints_count;
    END IF;
END $$;

