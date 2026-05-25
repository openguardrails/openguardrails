-- Migration: fix_private_model_id_column
-- Version: 042
-- Date: 2026-01-06
-- Author: OpenGuardrails Team

-- Description:
-- Fix column name mismatch: rename safe_model_id to private_model_id
-- in application_data_leakage_policies table to match the code model.

BEGIN;

-- Step 1: Rename safe_model_id to private_model_id if exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'application_data_leakage_policies' AND column_name = 'safe_model_id'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'application_data_leakage_policies' AND column_name = 'private_model_id'
    ) THEN
        ALTER TABLE application_data_leakage_policies RENAME COLUMN safe_model_id TO private_model_id;
        RAISE NOTICE 'Renamed safe_model_id to private_model_id in application_data_leakage_policies';
    ELSE
        RAISE NOTICE 'Column already correct or migration already applied';
    END IF;
END $$;

-- Step 2: Update foreign key constraint name if needed
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'application_data_leakage_policies_safe_model_id_fkey'
        AND table_name = 'application_data_leakage_policies'
    ) THEN
        ALTER TABLE application_data_leakage_policies
        DROP CONSTRAINT application_data_leakage_policies_safe_model_id_fkey;

        ALTER TABLE application_data_leakage_policies
        ADD CONSTRAINT application_data_leakage_policies_private_model_id_fkey
        FOREIGN KEY (private_model_id) REFERENCES upstream_api_configs(id) ON DELETE SET NULL;

        RAISE NOTICE 'Updated foreign key constraint name';
    END IF;
END $$;

COMMIT;
