-- Migration 077: Fix whitelist application_id nullable
-- Description: Ensure whitelist.application_id is nullable (workspace-only design).
--   Migration 065 wrapped DROP NOT NULL inside an IF block that could be skipped
--   if workspace_id column already existed, leaving the NOT NULL constraint.
--   Also drops the chk_whitelist_scope constraint if it still exists.

-- Drop the XOR constraint if it still exists (should have been dropped in 071)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_whitelist_scope') THEN
        ALTER TABLE whitelist DROP CONSTRAINT chk_whitelist_scope;
    END IF;
END $$;

-- Ensure application_id is nullable
ALTER TABLE whitelist ALTER COLUMN application_id DROP NOT NULL;
