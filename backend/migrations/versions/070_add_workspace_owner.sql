-- Migration: Add owner field to workspaces table
-- Description: Allow configuring workspace owner (person name), for future AD/LDAP integration

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'workspaces' AND column_name = 'owner') THEN
        ALTER TABLE workspaces ADD COLUMN owner VARCHAR(255);
    END IF;
END $$;
