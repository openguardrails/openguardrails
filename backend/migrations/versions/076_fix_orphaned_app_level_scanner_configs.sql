-- Migration: fix_orphaned_app_level_scanner_configs
-- Version: 076
-- Date: 2026-03-31
-- Description: After migration 071, all scanner configs should live at workspace level
--   (application_id IS NULL, workspace_id IS NOT NULL). However, a bug in
--   _initialize_scanner_configs_for_applications and update_scanner_config created
--   app-level records (application_id IS NOT NULL) that were invisible to the read path.
--   This migration merges any user overrides from those orphaned app-level records into
--   the corresponding workspace-level records, then deletes the orphans.

-- Step 1: For orphaned app-level configs that have user overrides, merge them into
-- the workspace-level config (prefer user overrides over NULL defaults).
-- Only update workspace configs where the override is still NULL (don't clobber
-- another workspace-level change).
UPDATE application_scanner_configs ws_cfg
SET
    is_enabled = COALESCE(app_cfg.is_enabled, ws_cfg.is_enabled),
    risk_level_override = COALESCE(ws_cfg.risk_level_override, app_cfg.risk_level_override),
    scan_prompt_override = COALESCE(ws_cfg.scan_prompt_override, app_cfg.scan_prompt_override),
    scan_response_override = COALESCE(ws_cfg.scan_response_override, app_cfg.scan_response_override),
    updated_at = NOW()
FROM application_scanner_configs app_cfg
JOIN applications a ON a.id = app_cfg.application_id
WHERE app_cfg.application_id IS NOT NULL          -- orphaned app-level record
  AND a.workspace_id IS NOT NULL
  AND ws_cfg.workspace_id = a.workspace_id        -- match to workspace-level record
  AND ws_cfg.application_id IS NULL               -- workspace-level record
  AND ws_cfg.scanner_id = app_cfg.scanner_id      -- same scanner
  AND (
      app_cfg.risk_level_override IS NOT NULL
      OR app_cfg.scan_prompt_override IS NOT NULL
      OR app_cfg.scan_response_override IS NOT NULL
      OR app_cfg.is_enabled = false
  );

-- Step 2: Delete all app-level scanner configs (they should not exist after 071)
DELETE FROM application_scanner_configs WHERE application_id IS NOT NULL;
