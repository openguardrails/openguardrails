-- Migration: Add doublecheck feature
-- Description: Add enable_doublecheck to workspaces table and doublecheck result fields to detection_results table
-- When enabled, unsafe detections are verified by a second AI review to reduce false positives

-- Workspace-level toggle for doublecheck feature (default off)
ALTER TABLE workspaces
ADD COLUMN IF NOT EXISTS enable_doublecheck BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN workspaces.enable_doublecheck IS 'Enable AI doublecheck for unsafe detections to reduce false positives. Default off.';

-- Detection result fields for doublecheck
ALTER TABLE detection_results
ADD COLUMN IF NOT EXISTS doublecheck_result VARCHAR(20);

ALTER TABLE detection_results
ADD COLUMN IF NOT EXISTS doublecheck_categories JSON;

ALTER TABLE detection_results
ADD COLUMN IF NOT EXISTS doublecheck_reasoning TEXT;

COMMENT ON COLUMN detection_results.doublecheck_result IS 'Doublecheck verdict: confirmed_unsafe, overturned_safe, or NULL if not doublechecked';
COMMENT ON COLUMN detection_results.doublecheck_categories IS 'Original categories before doublecheck (preserved when overturned)';
COMMENT ON COLUMN detection_results.doublecheck_reasoning IS 'AI reasoning from doublecheck review';
