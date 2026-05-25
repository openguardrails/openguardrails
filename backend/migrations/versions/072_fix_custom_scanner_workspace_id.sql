-- Migration: Fix custom_scanners workspace_id
-- Description: Backfill workspace_id on custom_scanners records that only have application_id.
--              Also migrate application_scanner_configs for custom scanners to workspace level.

-- 1. Backfill workspace_id on custom_scanners from their application's workspace
UPDATE custom_scanners cs
SET workspace_id = a.workspace_id
FROM applications a
WHERE cs.application_id = a.id
  AND cs.workspace_id IS NULL
  AND a.workspace_id IS NOT NULL;

-- 2. Migrate application-level scanner configs for custom scanners to workspace level
-- Find configs that reference custom scanners and have application_id but no workspace_id
INSERT INTO application_scanner_configs (id, workspace_id, scanner_id, is_enabled, risk_level_override, scan_prompt_override, scan_response_override, created_at, updated_at)
SELECT
    gen_random_uuid(),
    a.workspace_id,
    asc2.scanner_id,
    asc2.is_enabled,
    asc2.risk_level_override,
    asc2.scan_prompt_override,
    asc2.scan_response_override,
    asc2.created_at,
    asc2.updated_at
FROM application_scanner_configs asc2
JOIN applications a ON asc2.application_id = a.id
JOIN custom_scanners cs ON cs.scanner_id = asc2.scanner_id AND cs.application_id = asc2.application_id
WHERE asc2.application_id IS NOT NULL
  AND asc2.workspace_id IS NULL
  AND a.workspace_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM application_scanner_configs existing
    WHERE existing.workspace_id = a.workspace_id
      AND existing.scanner_id = asc2.scanner_id
      AND existing.application_id IS NULL
  );
