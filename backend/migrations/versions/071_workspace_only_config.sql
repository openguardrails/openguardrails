-- Migration: Move all configuration from application-level to workspace-level
-- Description: Config now lives ONLY at workspace level. Global config = a real "Global" workspace
--   per tenant. When a workspace is created, it copies from global. Once created, independent.
--   Applications inherit config from their workspace (no app-level config).

-- ============================================================
-- STEP 1: Add is_global flag to workspaces table
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'workspaces' AND column_name = 'is_global') THEN
        ALTER TABLE workspaces ADD COLUMN is_global BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
END $$;

-- Unique partial index: only one global workspace per tenant
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_tenant_global ON workspaces (tenant_id) WHERE is_global = TRUE;

-- ============================================================
-- STEP 2: Create a Global Workspace for each tenant that doesn't have one
-- ============================================================
INSERT INTO workspaces (id, tenant_id, name, description, is_global, created_at, updated_at)
SELECT gen_random_uuid(), t.id, 'Global', 'Default global workspace', TRUE, NOW(), NOW()
FROM tenants t
WHERE NOT EXISTS (
    SELECT 1 FROM workspaces w WHERE w.tenant_id = t.id AND w.is_global = TRUE
)
ON CONFLICT DO NOTHING;

-- ============================================================
-- STEP 3: Assign orphan applications (workspace_id IS NULL) to their tenant's global workspace
-- ============================================================
UPDATE applications a
SET workspace_id = w.id, updated_at = NOW()
FROM workspaces w
WHERE a.workspace_id IS NULL
  AND w.tenant_id = a.tenant_id
  AND w.is_global = TRUE;

-- ============================================================
-- STEP 4: Add workspace_id to tables that don't have it yet
-- ============================================================

-- 4a. data_security_entity_types
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'data_security_entity_types' AND column_name = 'workspace_id') THEN
        ALTER TABLE data_security_entity_types ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
        CREATE INDEX IF NOT EXISTS idx_data_security_entity_types_workspace_id ON data_security_entity_types(workspace_id);
    END IF;
END $$;

-- 4b. custom_scanners
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'custom_scanners' AND column_name = 'workspace_id') THEN
        ALTER TABLE custom_scanners ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
        ALTER TABLE custom_scanners ALTER COLUMN application_id DROP NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_custom_scanners_workspace_id ON custom_scanners(workspace_id);
    END IF;
END $$;

-- 4c. tenant_entity_type_disables
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'tenant_entity_type_disables' AND column_name = 'workspace_id') THEN
        ALTER TABLE tenant_entity_type_disables ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
        CREATE INDEX IF NOT EXISTS idx_tenant_entity_type_disables_workspace_id ON tenant_entity_type_disables(workspace_id);
    END IF;
END $$;

-- ============================================================
-- STEP 5: Migrate app-level configs to workspace-level
-- For each config table, copy the first app's config in each workspace
-- to become the workspace-level config (only if workspace doesn't already have one)
-- ============================================================

-- 5a. risk_type_config: copy first app's config per workspace
INSERT INTO risk_type_config (
    tenant_id, workspace_id,
    s1_enabled, s2_enabled, s3_enabled, s4_enabled, s5_enabled, s6_enabled, s7_enabled,
    s8_enabled, s9_enabled, s10_enabled, s11_enabled, s12_enabled, s13_enabled, s14_enabled,
    s15_enabled, s16_enabled, s17_enabled, s18_enabled, s19_enabled, s20_enabled, s21_enabled,
    high_sensitivity_threshold, medium_sensitivity_threshold, low_sensitivity_threshold,
    sensitivity_trigger_level, created_at, updated_at
)
SELECT DISTINCT ON (a.workspace_id)
    rtc.tenant_id, a.workspace_id,
    rtc.s1_enabled, rtc.s2_enabled, rtc.s3_enabled, rtc.s4_enabled, rtc.s5_enabled, rtc.s6_enabled, rtc.s7_enabled,
    rtc.s8_enabled, rtc.s9_enabled, rtc.s10_enabled, rtc.s11_enabled, rtc.s12_enabled, rtc.s13_enabled, rtc.s14_enabled,
    rtc.s15_enabled, rtc.s16_enabled, rtc.s17_enabled, rtc.s18_enabled, rtc.s19_enabled, rtc.s20_enabled, rtc.s21_enabled,
    rtc.high_sensitivity_threshold, rtc.medium_sensitivity_threshold, rtc.low_sensitivity_threshold,
    rtc.sensitivity_trigger_level, NOW(), NOW()
FROM risk_type_config rtc
JOIN applications a ON a.id = rtc.application_id
WHERE a.workspace_id IS NOT NULL
  AND rtc.application_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM risk_type_config rtc2
      WHERE rtc2.workspace_id = a.workspace_id AND rtc2.application_id IS NULL
  )
ORDER BY a.workspace_id, a.created_at ASC;

-- 5b. ban_policies: copy first app's config per workspace
INSERT INTO ban_policies (
    id, tenant_id, workspace_id,
    enabled, risk_level, trigger_count, time_window_minutes, ban_duration_minutes,
    created_at, updated_at
)
SELECT DISTINCT ON (a.workspace_id)
    gen_random_uuid(), bp.tenant_id, a.workspace_id,
    bp.enabled, bp.risk_level, bp.trigger_count, bp.time_window_minutes, bp.ban_duration_minutes,
    NOW(), NOW()
FROM ban_policies bp
JOIN applications a ON a.id = bp.application_id
WHERE a.workspace_id IS NOT NULL
  AND bp.application_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM ban_policies bp2
      WHERE bp2.workspace_id = a.workspace_id AND bp2.application_id IS NULL
  )
ORDER BY a.workspace_id, a.created_at ASC;

-- 5c. blacklist: copy ALL app-level blacklists to workspace (with dedup by name)
INSERT INTO blacklist (
    tenant_id, workspace_id, name, keywords, is_active, created_at, updated_at
)
SELECT DISTINCT ON (a.workspace_id, bl.name)
    bl.tenant_id, a.workspace_id, bl.name, bl.keywords, bl.is_active, NOW(), NOW()
FROM blacklist bl
JOIN applications a ON a.id = bl.application_id
WHERE a.workspace_id IS NOT NULL
  AND bl.application_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM blacklist bl2
      WHERE bl2.workspace_id = a.workspace_id AND bl2.application_id IS NULL AND bl2.name = bl.name
  )
ORDER BY a.workspace_id, bl.name, a.created_at ASC;

-- 5d. whitelist: same as blacklist
INSERT INTO whitelist (
    tenant_id, workspace_id, name, keywords, is_active, created_at, updated_at
)
SELECT DISTINCT ON (a.workspace_id, wl.name)
    wl.tenant_id, a.workspace_id, wl.name, wl.keywords, wl.is_active, NOW(), NOW()
FROM whitelist wl
JOIN applications a ON a.id = wl.application_id
WHERE a.workspace_id IS NOT NULL
  AND wl.application_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM whitelist wl2
      WHERE wl2.workspace_id = a.workspace_id AND wl2.application_id IS NULL AND wl2.name = wl.name
  )
ORDER BY a.workspace_id, wl.name, a.created_at ASC;

-- 5e. application_data_leakage_policies: copy first app's config per workspace
INSERT INTO application_data_leakage_policies (
    id, tenant_id, workspace_id,
    input_high_risk_action, input_medium_risk_action, input_low_risk_action,
    output_high_risk_anonymize, output_medium_risk_anonymize, output_low_risk_anonymize,
    output_high_risk_action, output_medium_risk_action, output_low_risk_action,
    general_high_risk_action, general_medium_risk_action, general_low_risk_action,
    general_input_high_risk_action, general_input_medium_risk_action, general_input_low_risk_action,
    general_output_high_risk_action, general_output_medium_risk_action, general_output_low_risk_action,
    private_model_id, enable_format_detection, enable_smart_segmentation,
    created_at, updated_at
)
SELECT DISTINCT ON (a.workspace_id)
    gen_random_uuid(), dlp.tenant_id, a.workspace_id,
    dlp.input_high_risk_action, dlp.input_medium_risk_action, dlp.input_low_risk_action,
    dlp.output_high_risk_anonymize, dlp.output_medium_risk_anonymize, dlp.output_low_risk_anonymize,
    dlp.output_high_risk_action, dlp.output_medium_risk_action, dlp.output_low_risk_action,
    dlp.general_high_risk_action, dlp.general_medium_risk_action, dlp.general_low_risk_action,
    dlp.general_input_high_risk_action, dlp.general_input_medium_risk_action, dlp.general_input_low_risk_action,
    dlp.general_output_high_risk_action, dlp.general_output_medium_risk_action, dlp.general_output_low_risk_action,
    dlp.private_model_id, dlp.enable_format_detection, dlp.enable_smart_segmentation,
    NOW(), NOW()
FROM application_data_leakage_policies dlp
JOIN applications a ON a.id = dlp.application_id
WHERE a.workspace_id IS NOT NULL
  AND dlp.application_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM application_data_leakage_policies dlp2
      WHERE dlp2.workspace_id = a.workspace_id AND dlp2.application_id IS NULL
  )
ORDER BY a.workspace_id, a.created_at ASC;

-- 5f. application_scanner_configs: copy first app's configs per workspace (per scanner)
INSERT INTO application_scanner_configs (
    id, workspace_id, scanner_id,
    is_enabled, risk_level_override, scan_prompt_override, scan_response_override,
    created_at, updated_at
)
SELECT DISTINCT ON (a.workspace_id, asc2.scanner_id)
    gen_random_uuid(), a.workspace_id, asc2.scanner_id,
    asc2.is_enabled, asc2.risk_level_override, asc2.scan_prompt_override, asc2.scan_response_override,
    NOW(), NOW()
FROM application_scanner_configs asc2
JOIN applications a ON a.id = asc2.application_id
WHERE a.workspace_id IS NOT NULL
  AND asc2.application_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM application_scanner_configs asc3
      WHERE asc3.workspace_id = a.workspace_id AND asc3.application_id IS NULL AND asc3.scanner_id = asc2.scanner_id
  )
ORDER BY a.workspace_id, asc2.scanner_id, a.created_at ASC;

-- 5g. application_settings: copy first app's settings per workspace
INSERT INTO application_settings (
    id, tenant_id, workspace_id,
    security_risk_template, data_leakage_template,
    created_at, updated_at
)
SELECT DISTINCT ON (a.workspace_id)
    gen_random_uuid(), s.tenant_id, a.workspace_id,
    s.security_risk_template, s.data_leakage_template,
    NOW(), NOW()
FROM application_settings s
JOIN applications a ON a.id = s.application_id
WHERE a.workspace_id IS NOT NULL
  AND s.application_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM application_settings s2
      WHERE s2.workspace_id = a.workspace_id AND s2.application_id IS NULL
  )
ORDER BY a.workspace_id, a.created_at ASC;

-- 5h. data_security_entity_types: move app-level to workspace-level
-- Set workspace_id from application's workspace, then clear application_id
-- For duplicates (same entity_type in same workspace from different apps), keep only first
DO $$
DECLARE
    ws_record RECORD;
BEGIN
    -- For each workspace, pick entity types from first app if workspace doesn't have its own
    FOR ws_record IN
        SELECT DISTINCT a.workspace_id
        FROM data_security_entity_types dset
        JOIN applications a ON a.id = dset.application_id
        WHERE a.workspace_id IS NOT NULL AND dset.application_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM data_security_entity_types dset2
              WHERE dset2.workspace_id = a.workspace_id AND dset2.application_id IS NULL
          )
    LOOP
        -- Get the first app in this workspace
        INSERT INTO data_security_entity_types (
            id, tenant_id, workspace_id, entity_type, entity_type_name, category,
            recognition_method, recognition_config, anonymization_method, anonymization_config,
            is_active, is_global, source_type, template_id,
            restore_code, restore_code_hash, restore_natural_desc,
            created_at, updated_at
        )
        SELECT DISTINCT ON (dset.entity_type)
            gen_random_uuid(), dset.tenant_id, ws_record.workspace_id,
            dset.entity_type, dset.entity_type_name, dset.category,
            dset.recognition_method, dset.recognition_config, dset.anonymization_method, dset.anonymization_config,
            dset.is_active, dset.is_global, dset.source_type, dset.template_id,
            dset.restore_code, dset.restore_code_hash, dset.restore_natural_desc,
            NOW(), NOW()
        FROM data_security_entity_types dset
        JOIN applications a ON a.id = dset.application_id
        WHERE a.workspace_id = ws_record.workspace_id
          AND dset.application_id IS NOT NULL
        ORDER BY dset.entity_type, a.created_at ASC;
    END LOOP;
END $$;

-- 5i. custom_scanners: move app-level to workspace-level
DO $$
DECLARE
    ws_record RECORD;
BEGIN
    FOR ws_record IN
        SELECT DISTINCT a.workspace_id
        FROM custom_scanners cs
        JOIN applications a ON a.id = cs.application_id
        WHERE a.workspace_id IS NOT NULL AND cs.application_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1 FROM custom_scanners cs2
              WHERE cs2.workspace_id = a.workspace_id AND cs2.application_id IS NULL
          )
    LOOP
        INSERT INTO custom_scanners (
            id, workspace_id, scanner_id, created_by, notes, created_at, updated_at
        )
        SELECT DISTINCT ON (cs.scanner_id)
            gen_random_uuid(), ws_record.workspace_id, cs.scanner_id, cs.created_by, cs.notes, NOW(), NOW()
        FROM custom_scanners cs
        JOIN applications a ON a.id = cs.application_id
        WHERE a.workspace_id = ws_record.workspace_id
          AND cs.application_id IS NOT NULL
        ORDER BY cs.scanner_id, a.created_at ASC;
    END LOOP;
END $$;

-- 5j. tenant_entity_type_disables: move app-level to workspace-level
UPDATE tenant_entity_type_disables d
SET workspace_id = a.workspace_id
FROM applications a
WHERE d.application_id = a.id
  AND a.workspace_id IS NOT NULL
  AND d.workspace_id IS NULL;

-- ============================================================
-- STEP 6: Delete app-level config rows (workspace copies now exist)
-- ============================================================

DELETE FROM risk_type_config WHERE application_id IS NOT NULL;
DELETE FROM ban_policies WHERE application_id IS NOT NULL;
DELETE FROM blacklist WHERE application_id IS NOT NULL;
DELETE FROM whitelist WHERE application_id IS NOT NULL;
DELETE FROM application_data_leakage_policies WHERE application_id IS NOT NULL;
DELETE FROM application_scanner_configs WHERE application_id IS NOT NULL;
DELETE FROM application_settings WHERE application_id IS NOT NULL;
DELETE FROM data_security_entity_types WHERE application_id IS NOT NULL;
DELETE FROM custom_scanners WHERE application_id IS NOT NULL;
DELETE FROM tenant_entity_type_disables WHERE application_id IS NOT NULL;

-- ============================================================
-- STEP 7: Drop old XOR constraints (no longer need app vs workspace choice)
-- and add workspace-only constraints
-- ============================================================

-- Drop XOR check constraints from migration 065
ALTER TABLE risk_type_config DROP CONSTRAINT IF EXISTS chk_risk_type_config_scope;
ALTER TABLE ban_policies DROP CONSTRAINT IF EXISTS chk_ban_policies_scope;
ALTER TABLE application_data_leakage_policies DROP CONSTRAINT IF EXISTS chk_app_dlp_scope;
ALTER TABLE blacklist DROP CONSTRAINT IF EXISTS chk_blacklist_scope;
ALTER TABLE whitelist DROP CONSTRAINT IF EXISTS chk_whitelist_scope;
ALTER TABLE application_scanner_configs DROP CONSTRAINT IF EXISTS chk_app_scanner_configs_scope;
ALTER TABLE application_settings DROP CONSTRAINT IF EXISTS chk_app_settings_scope;

-- Add workspace-only unique constraints for newly migrated tables
CREATE UNIQUE INDEX IF NOT EXISTS uq_data_security_entity_types_ws_entity
    ON data_security_entity_types(workspace_id, entity_type) WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_scanners_ws_scanner
    ON custom_scanners(workspace_id, scanner_id) WHERE workspace_id IS NOT NULL;

-- Migration 071 complete: All configs moved to workspace level
