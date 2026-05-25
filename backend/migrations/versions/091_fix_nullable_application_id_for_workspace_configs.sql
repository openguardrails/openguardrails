-- Migration: Fix application_id NOT NULL constraint on workspace-level config tables
-- Description: Migration 065 conditionally dropped NOT NULL on application_id, but the
--   condition (IF NOT EXISTS workspace_id) can be false when tables were created by
--   SQLAlchemy create_all() before migrations ran. This left application_id as NOT NULL
--   even though workspace-level configs require application_id to be NULL.
--   Affected tables: those where migration 011 SET NOT NULL and 065's DROP NOT NULL was skipped.

-- Unconditionally ensure application_id is nullable on all config tables
-- that support workspace-level configs (application_id=NULL, workspace_id=set)

ALTER TABLE risk_type_config ALTER COLUMN application_id DROP NOT NULL;
ALTER TABLE blacklist ALTER COLUMN application_id DROP NOT NULL;
ALTER TABLE whitelist ALTER COLUMN application_id DROP NOT NULL;
ALTER TABLE application_data_leakage_policies ALTER COLUMN application_id DROP NOT NULL;
ALTER TABLE application_scanner_configs ALTER COLUMN application_id DROP NOT NULL;
ALTER TABLE application_settings ALTER COLUMN application_id DROP NOT NULL;
