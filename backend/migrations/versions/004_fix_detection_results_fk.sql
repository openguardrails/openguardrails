-- Fix detection_results foreign key constraint
-- The foreign key was incorrectly referencing 'users' table instead of 'tenants' table
--
-- Migration: 004_fix_detection_results_fk
-- Date: 2025-10-22
-- Description: Fix foreign key constraint on detection_results.tenant_id to reference tenants table

-- Drop the incorrect foreign key constraint
ALTER TABLE detection_results DROP CONSTRAINT IF EXISTS detection_results_user_id_fkey;

-- Add the correct foreign key constraint (idempotent)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'detection_results_tenant_id_fkey'
    ) THEN
        ALTER TABLE detection_results ADD CONSTRAINT detection_results_tenant_id_fkey
            FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
    END IF;
END $$;

-- Optionally, rename the index to match the new constraint name
ALTER INDEX IF EXISTS ix_detection_results_user_id RENAME TO ix_detection_results_tenant_id;

