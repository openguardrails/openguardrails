-- Migration: Add workspace-level guardrail configuration support
-- Description: Allow guardrail configs (risk types, blacklist/whitelist, ban policy,
--   data masking policy, scanner configs, app settings) to be scoped at workspace level.
--   Inheritance chain: application config → workspace config → tenant default.

-- ============================================================
-- 1. risk_type_config: add workspace_id, make application_id nullable
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'risk_type_config' AND column_name = 'workspace_id') THEN
        ALTER TABLE risk_type_config ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
        ALTER TABLE risk_type_config ALTER COLUMN application_id DROP NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_risk_type_config_workspace_id ON risk_type_config(workspace_id);
    END IF;
END $$;

-- Unique constraint: one config per workspace
CREATE UNIQUE INDEX IF NOT EXISTS uq_risk_type_config_workspace ON risk_type_config(workspace_id) WHERE workspace_id IS NOT NULL;

-- Check constraint: exactly one scope must be set
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_risk_type_config_scope') THEN
        ALTER TABLE risk_type_config ADD CONSTRAINT chk_risk_type_config_scope
            CHECK (
                (application_id IS NOT NULL AND workspace_id IS NULL) OR
                (application_id IS NULL AND workspace_id IS NOT NULL)
            );
    END IF;
END $$;

-- ============================================================
-- 2. ban_policies: add workspace_id, make application_id nullable
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ban_policies' AND column_name = 'workspace_id') THEN
        ALTER TABLE ban_policies ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
        ALTER TABLE ban_policies ALTER COLUMN application_id DROP NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_ban_policies_workspace_id ON ban_policies(workspace_id);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ban_policies_workspace ON ban_policies(workspace_id) WHERE workspace_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ban_policies_scope') THEN
        ALTER TABLE ban_policies ADD CONSTRAINT chk_ban_policies_scope
            CHECK (
                (application_id IS NOT NULL AND workspace_id IS NULL) OR
                (application_id IS NULL AND workspace_id IS NOT NULL)
            );
    END IF;
END $$;

-- ============================================================
-- 3. application_data_leakage_policies: add workspace_id, make application_id nullable
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'application_data_leakage_policies' AND column_name = 'workspace_id') THEN
        ALTER TABLE application_data_leakage_policies ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
        ALTER TABLE application_data_leakage_policies ALTER COLUMN application_id DROP NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_app_dlp_workspace_id ON application_data_leakage_policies(workspace_id);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_dlp_workspace ON application_data_leakage_policies(workspace_id) WHERE workspace_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_app_dlp_scope') THEN
        ALTER TABLE application_data_leakage_policies ADD CONSTRAINT chk_app_dlp_scope
            CHECK (
                (application_id IS NOT NULL AND workspace_id IS NULL) OR
                (application_id IS NULL AND workspace_id IS NOT NULL)
            );
    END IF;
END $$;

-- ============================================================
-- 4. blacklist: add workspace_id, make application_id nullable
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'blacklist' AND column_name = 'workspace_id') THEN
        ALTER TABLE blacklist ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
        ALTER TABLE blacklist ALTER COLUMN application_id DROP NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_blacklist_workspace_id ON blacklist(workspace_id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_blacklist_scope') THEN
        ALTER TABLE blacklist ADD CONSTRAINT chk_blacklist_scope
            CHECK (
                (application_id IS NOT NULL AND workspace_id IS NULL) OR
                (application_id IS NULL AND workspace_id IS NOT NULL)
            );
    END IF;
END $$;

-- ============================================================
-- 5. whitelist: add workspace_id, make application_id nullable
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'whitelist' AND column_name = 'workspace_id') THEN
        ALTER TABLE whitelist ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
        ALTER TABLE whitelist ALTER COLUMN application_id DROP NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_whitelist_workspace_id ON whitelist(workspace_id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_whitelist_scope') THEN
        ALTER TABLE whitelist ADD CONSTRAINT chk_whitelist_scope
            CHECK (
                (application_id IS NOT NULL AND workspace_id IS NULL) OR
                (application_id IS NULL AND workspace_id IS NOT NULL)
            );
    END IF;
END $$;

-- ============================================================
-- 6. application_scanner_configs: add workspace_id, make application_id nullable
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'application_scanner_configs' AND column_name = 'workspace_id') THEN
        ALTER TABLE application_scanner_configs ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
        ALTER TABLE application_scanner_configs ALTER COLUMN application_id DROP NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_app_scanner_configs_workspace_id ON application_scanner_configs(workspace_id);
    END IF;
END $$;

-- Unique constraint: one config per scanner per workspace
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_scanner_configs_workspace_scanner
    ON application_scanner_configs(workspace_id, scanner_id) WHERE workspace_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_app_scanner_configs_scope') THEN
        ALTER TABLE application_scanner_configs ADD CONSTRAINT chk_app_scanner_configs_scope
            CHECK (
                (application_id IS NOT NULL AND workspace_id IS NULL) OR
                (application_id IS NULL AND workspace_id IS NOT NULL)
            );
    END IF;
END $$;

-- ============================================================
-- 7. application_settings: add workspace_id, make application_id nullable
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'application_settings' AND column_name = 'workspace_id') THEN
        ALTER TABLE application_settings ADD COLUMN workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE;
        ALTER TABLE application_settings ALTER COLUMN application_id DROP NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_app_settings_workspace_id ON application_settings(workspace_id);
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_app_settings_workspace ON application_settings(workspace_id) WHERE workspace_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_app_settings_scope') THEN
        ALTER TABLE application_settings ADD CONSTRAINT chk_app_settings_scope
            CHECK (
                (application_id IS NOT NULL AND workspace_id IS NULL) OR
                (application_id IS NULL AND workspace_id IS NOT NULL)
            );
    END IF;
END $$;
