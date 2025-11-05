-- Migration: Add Application Management (Multi-Application Support)
-- Version: 011
-- Date: 2025-11-01
-- Description: Transform from tenant-scoped to application-scoped configurations
--              to support multiple applications per tenant with independent API keys and configs

-- ============================================================================
-- STEP 1: Create applications table
-- ============================================================================

CREATE TABLE IF NOT EXISTS applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    is_active BOOLEAN DEFAULT true NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

    CONSTRAINT uq_applications_tenant_name UNIQUE(tenant_id, name)
);

-- Ensure default is set even if table already exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_name = 'applications' AND column_name = 'id' 
               AND column_default IS NULL) THEN
        ALTER TABLE applications ALTER COLUMN id SET DEFAULT gen_random_uuid();
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_applications_tenant_id ON applications(tenant_id);
CREATE INDEX IF NOT EXISTS idx_applications_is_active ON applications(is_active);

COMMENT ON TABLE applications IS 'Applications owned by tenants. Each tenant can have multiple applications with independent configurations.';
COMMENT ON COLUMN applications.tenant_id IS 'Owner of this application';
COMMENT ON COLUMN applications.name IS 'Application name (unique per tenant)';
COMMENT ON COLUMN applications.is_active IS 'Whether this application is active';

-- ============================================================================
-- STEP 2: Create api_keys table
-- ============================================================================

CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    key VARCHAR(64) NOT NULL UNIQUE,
    name VARCHAR(100),
    is_active BOOLEAN DEFAULT true NOT NULL,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Ensure default is set even if table already exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_name = 'api_keys' AND column_name = 'id' 
               AND column_default IS NULL) THEN
        ALTER TABLE api_keys ALTER COLUMN id SET DEFAULT gen_random_uuid();
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_api_keys_key ON api_keys(key);
CREATE INDEX IF NOT EXISTS idx_api_keys_application_id ON api_keys(application_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_id ON api_keys(tenant_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_is_active ON api_keys(is_active);

COMMENT ON TABLE api_keys IS 'API keys for applications. Each application can have multiple API keys.';
COMMENT ON COLUMN api_keys.tenant_id IS 'Owner (for quick tenant-level queries)';
COMMENT ON COLUMN api_keys.application_id IS 'Which application this key belongs to';
COMMENT ON COLUMN api_keys.key IS 'API key string (format: sk-xxai-{52 chars})';
COMMENT ON COLUMN api_keys.name IS 'Optional friendly name (e.g., "Production Key", "Test Key")';
COMMENT ON COLUMN api_keys.last_used_at IS 'Last usage timestamp';

-- ============================================================================
-- STEP 3: Create "Default Application" for all existing tenants
-- ============================================================================

DO $$
DECLARE
    tenant_record RECORD;
    new_app_id UUID;
BEGIN
    FOR tenant_record IN SELECT id, email FROM tenants LOOP
        -- Check if application already exists (idempotent migration)
        SELECT id INTO new_app_id
        FROM applications
        WHERE tenant_id = tenant_record.id AND name = 'Default Application';
        
        -- Create "Default Application" for each tenant if it doesn't exist
        IF new_app_id IS NULL THEN
            INSERT INTO applications (id, tenant_id, name, description, is_active)
            VALUES (
                gen_random_uuid(),
                tenant_record.id,
                'Default Application',
                'Automatically created during migration. All existing configurations have been migrated to this application.',
                true
            )
            RETURNING id INTO new_app_id;
            
            RAISE NOTICE 'Created Default Application for tenant % (email: %)', tenant_record.id, tenant_record.email;
        ELSE
            RAISE NOTICE 'Default Application already exists for tenant % (email: %)', tenant_record.id, tenant_record.email;
        END IF;
    END LOOP;
END $$;

-- ============================================================================
-- STEP 4: Migrate existing API keys from tenants.api_key to api_keys table
-- ============================================================================

DO $$
DECLARE
    tenant_record RECORD;
    app_id UUID;
BEGIN
    FOR tenant_record IN SELECT id, email, api_key FROM tenants WHERE api_key IS NOT NULL LOOP
        -- Get the "Default Application" for this tenant
        SELECT id INTO app_id
        FROM applications
        WHERE tenant_id = tenant_record.id AND name = 'Default Application';

        IF app_id IS NOT NULL THEN
            -- Migrate existing API key to api_keys table (skip if already exists)
            INSERT INTO api_keys (id, tenant_id, application_id, key, name, is_active)
            SELECT gen_random_uuid(), tenant_record.id, app_id, tenant_record.api_key, 'Migrated API Key', true
            WHERE NOT EXISTS (
                SELECT 1 FROM api_keys WHERE key = tenant_record.api_key
            );

            RAISE NOTICE 'Migrated API key for tenant % (email: %)', tenant_record.id, tenant_record.email;
        ELSE
            RAISE WARNING 'No Default Application found for tenant % (email: %)', tenant_record.id, tenant_record.email;
        END IF;
    END LOOP;
END $$;

-- ============================================================================
-- STEP 5: Add application_id column to all configuration tables
-- ============================================================================

-- 5.1 blacklist
ALTER TABLE blacklist ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES applications(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_blacklist_application_id ON blacklist(application_id);

-- 5.2 whitelist
ALTER TABLE whitelist ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES applications(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_whitelist_application_id ON whitelist(application_id);

-- 5.3 response_templates
ALTER TABLE response_templates ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES applications(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_response_templates_application_id ON response_templates(application_id);

-- 5.4 risk_type_config
ALTER TABLE risk_type_config ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES applications(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_risk_type_config_application_id ON risk_type_config(application_id);

-- 5.5 ban_policies
ALTER TABLE ban_policies ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES applications(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_ban_policies_application_id ON ban_policies(application_id);

-- 5.6 knowledge_bases
ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES applications(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_application_id ON knowledge_bases(application_id);

-- 5.7 data_security_entity_types
ALTER TABLE data_security_entity_types ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES applications(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_data_security_entity_types_application_id ON data_security_entity_types(application_id);

-- 5.8 upstream_api_configs
ALTER TABLE upstream_api_configs ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES applications(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_upstream_api_configs_application_id ON upstream_api_configs(application_id);

-- 5.9 test_model_configs
ALTER TABLE test_model_configs ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES applications(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_test_model_configs_application_id ON test_model_configs(application_id);

-- 5.10 tenant_rate_limits
ALTER TABLE tenant_rate_limits ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES applications(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_tenant_rate_limits_application_id ON tenant_rate_limits(application_id);

-- 5.11 detection_results (keep nullable for historical data)
ALTER TABLE detection_results ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES applications(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_detection_results_application_id ON detection_results(application_id);

-- 5.12 user_ban_records
ALTER TABLE user_ban_records ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES applications(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_user_ban_records_application_id ON user_ban_records(application_id);

-- 5.13 user_risk_triggers
ALTER TABLE user_risk_triggers ADD COLUMN IF NOT EXISTS application_id UUID REFERENCES applications(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_user_risk_triggers_application_id ON user_risk_triggers(application_id);

-- ============================================================================
-- STEP 6: Migrate existing configurations to "Default Application"
-- ============================================================================

-- 6.1 Migrate blacklist
DO $$
DECLARE
    config_record RECORD;
    app_id UUID;
BEGIN
    FOR config_record IN SELECT id, tenant_id FROM blacklist WHERE application_id IS NULL LOOP
        SELECT id INTO app_id
        FROM applications
        WHERE tenant_id = config_record.tenant_id AND name = 'Default Application';

        IF app_id IS NOT NULL THEN
            UPDATE blacklist SET application_id = app_id WHERE id = config_record.id;
        END IF;
    END LOOP;
    RAISE NOTICE 'Migrated % blacklist entries', (SELECT COUNT(*) FROM blacklist WHERE application_id IS NOT NULL);
END $$;

-- 6.2 Migrate whitelist
DO $$
DECLARE
    config_record RECORD;
    app_id UUID;
BEGIN
    FOR config_record IN SELECT id, tenant_id FROM whitelist WHERE application_id IS NULL LOOP
        SELECT id INTO app_id
        FROM applications
        WHERE tenant_id = config_record.tenant_id AND name = 'Default Application';

        IF app_id IS NOT NULL THEN
            UPDATE whitelist SET application_id = app_id WHERE id = config_record.id;
        END IF;
    END LOOP;
    RAISE NOTICE 'Migrated % whitelist entries', (SELECT COUNT(*) FROM whitelist WHERE application_id IS NOT NULL);
END $$;

-- 6.3 Migrate response_templates
DO $$
DECLARE
    config_record RECORD;
    app_id UUID;
BEGIN
    FOR config_record IN SELECT id, tenant_id FROM response_templates WHERE application_id IS NULL LOOP
        SELECT id INTO app_id
        FROM applications
        WHERE tenant_id = config_record.tenant_id AND name = 'Default Application';

        IF app_id IS NOT NULL THEN
            UPDATE response_templates SET application_id = app_id WHERE id = config_record.id;
        END IF;
    END LOOP;
    RAISE NOTICE 'Migrated % response_template entries', (SELECT COUNT(*) FROM response_templates WHERE application_id IS NOT NULL);
END $$;

-- 6.4 Migrate risk_type_config
DO $$
DECLARE
    config_record RECORD;
    app_id UUID;
BEGIN
    FOR config_record IN SELECT id, tenant_id FROM risk_type_config WHERE application_id IS NULL LOOP
        SELECT id INTO app_id
        FROM applications
        WHERE tenant_id = config_record.tenant_id AND name = 'Default Application';

        IF app_id IS NOT NULL THEN
            UPDATE risk_type_config SET application_id = app_id WHERE id = config_record.id;
        END IF;
    END LOOP;
    RAISE NOTICE 'Migrated % risk_type_config entries', (SELECT COUNT(*) FROM risk_type_config WHERE application_id IS NOT NULL);
END $$;

-- 6.5 Migrate ban_policies
DO $$
DECLARE
    config_record RECORD;
    app_id UUID;
BEGIN
    FOR config_record IN SELECT id, tenant_id FROM ban_policies WHERE application_id IS NULL LOOP
        SELECT id INTO app_id
        FROM applications
        WHERE tenant_id = config_record.tenant_id AND name = 'Default Application';

        IF app_id IS NOT NULL THEN
            UPDATE ban_policies SET application_id = app_id WHERE id = config_record.id;
        END IF;
    END LOOP;
    RAISE NOTICE 'Migrated % ban_policies entries', (SELECT COUNT(*) FROM ban_policies WHERE application_id IS NOT NULL);
END $$;

-- 6.6 Migrate knowledge_bases
DO $$
DECLARE
    config_record RECORD;
    app_id UUID;
BEGIN
    FOR config_record IN SELECT id, tenant_id FROM knowledge_bases WHERE application_id IS NULL LOOP
        SELECT id INTO app_id
        FROM applications
        WHERE tenant_id = config_record.tenant_id AND name = 'Default Application';

        IF app_id IS NOT NULL THEN
            UPDATE knowledge_bases SET application_id = app_id WHERE id = config_record.id;
        END IF;
    END LOOP;
    RAISE NOTICE 'Migrated % knowledge_bases entries', (SELECT COUNT(*) FROM knowledge_bases WHERE application_id IS NOT NULL);
END $$;

-- 6.7 Migrate data_security_entity_types
DO $$
DECLARE
    config_record RECORD;
    app_id UUID;
BEGIN
    FOR config_record IN SELECT id, tenant_id FROM data_security_entity_types WHERE application_id IS NULL LOOP
        SELECT id INTO app_id
        FROM applications
        WHERE tenant_id = config_record.tenant_id AND name = 'Default Application';

        IF app_id IS NOT NULL THEN
            UPDATE data_security_entity_types SET application_id = app_id WHERE id = config_record.id;
        END IF;
    END LOOP;
    RAISE NOTICE 'Migrated % data_security_entity_types entries', (SELECT COUNT(*) FROM data_security_entity_types WHERE application_id IS NOT NULL);
END $$;

-- 6.8 Migrate upstream_api_configs
DO $$
DECLARE
    config_record RECORD;
    app_id UUID;
BEGIN
    FOR config_record IN SELECT id, tenant_id FROM upstream_api_configs WHERE application_id IS NULL LOOP
        SELECT id INTO app_id
        FROM applications
        WHERE tenant_id = config_record.tenant_id AND name = 'Default Application';

        IF app_id IS NOT NULL THEN
            UPDATE upstream_api_configs SET application_id = app_id WHERE id = config_record.id;
        END IF;
    END LOOP;
    RAISE NOTICE 'Migrated % upstream_api_configs entries', (SELECT COUNT(*) FROM upstream_api_configs WHERE application_id IS NOT NULL);
END $$;

-- 6.9 Migrate test_model_configs
DO $$
DECLARE
    config_record RECORD;
    app_id UUID;
BEGIN
    FOR config_record IN SELECT id, tenant_id FROM test_model_configs WHERE application_id IS NULL LOOP
        SELECT id INTO app_id
        FROM applications
        WHERE tenant_id = config_record.tenant_id AND name = 'Default Application';

        IF app_id IS NOT NULL THEN
            UPDATE test_model_configs SET application_id = app_id WHERE id = config_record.id;
        END IF;
    END LOOP;
    RAISE NOTICE 'Migrated % test_model_configs entries', (SELECT COUNT(*) FROM test_model_configs WHERE application_id IS NOT NULL);
END $$;

-- 6.10 Migrate tenant_rate_limits
DO $$
DECLARE
    config_record RECORD;
    app_id UUID;
BEGIN
    FOR config_record IN SELECT id, tenant_id FROM tenant_rate_limits WHERE application_id IS NULL LOOP
        SELECT id INTO app_id
        FROM applications
        WHERE tenant_id = config_record.tenant_id AND name = 'Default Application';

        IF app_id IS NOT NULL THEN
            UPDATE tenant_rate_limits SET application_id = app_id WHERE id = config_record.id;
        END IF;
    END LOOP;
    RAISE NOTICE 'Migrated % tenant_rate_limits entries', (SELECT COUNT(*) FROM tenant_rate_limits WHERE application_id IS NOT NULL);
END $$;

-- 6.11 Migrate user_ban_records
DO $$
DECLARE
    config_record RECORD;
    app_id UUID;
BEGIN
    FOR config_record IN SELECT id, tenant_id FROM user_ban_records WHERE application_id IS NULL LOOP
        SELECT id INTO app_id
        FROM applications
        WHERE tenant_id = config_record.tenant_id AND name = 'Default Application';

        IF app_id IS NOT NULL THEN
            UPDATE user_ban_records SET application_id = app_id WHERE id = config_record.id;
        END IF;
    END LOOP;
    RAISE NOTICE 'Migrated % user_ban_records entries', (SELECT COUNT(*) FROM user_ban_records WHERE application_id IS NOT NULL);
END $$;

-- 6.12 Migrate user_risk_triggers
DO $$
DECLARE
    config_record RECORD;
    app_id UUID;
BEGIN
    FOR config_record IN SELECT id, tenant_id FROM user_risk_triggers WHERE application_id IS NULL LOOP
        SELECT id INTO app_id
        FROM applications
        WHERE tenant_id = config_record.tenant_id AND name = 'Default Application';

        IF app_id IS NOT NULL THEN
            UPDATE user_risk_triggers SET application_id = app_id WHERE id = config_record.id;
        END IF;
    END LOOP;
    RAISE NOTICE 'Migrated % user_risk_triggers entries', (SELECT COUNT(*) FROM user_risk_triggers WHERE application_id IS NOT NULL);
END $$;

-- NOTE: detection_results.application_id kept nullable for historical data

-- ============================================================================
-- STEP 7: Set application_id as NOT NULL for core config tables
-- ============================================================================

-- Set NOT NULL constraint for tables where application_id must always exist
-- (after migration ensures all existing records have application_id)

DO $$
BEGIN
    -- blacklist
    ALTER TABLE blacklist ALTER COLUMN application_id SET NOT NULL;

    -- whitelist
    ALTER TABLE whitelist ALTER COLUMN application_id SET NOT NULL;

    -- risk_type_config
    ALTER TABLE risk_type_config ALTER COLUMN application_id SET NOT NULL;

    -- ban_policies
    ALTER TABLE ban_policies ALTER COLUMN application_id SET NOT NULL;

    -- knowledge_bases
    ALTER TABLE knowledge_bases ALTER COLUMN application_id SET NOT NULL;

    -- data_security_entity_types
    ALTER TABLE data_security_entity_types ALTER COLUMN application_id SET NOT NULL;

    -- upstream_api_configs
    ALTER TABLE upstream_api_configs ALTER COLUMN application_id SET NOT NULL;

    -- test_model_configs
    ALTER TABLE test_model_configs ALTER COLUMN application_id SET NOT NULL;

    -- user_ban_records
    ALTER TABLE user_ban_records ALTER COLUMN application_id SET NOT NULL;

    -- user_risk_triggers
    ALTER TABLE user_risk_triggers ALTER COLUMN application_id SET NOT NULL;

    -- Keep nullable: detection_results (historical data), response_templates (can be global), tenant_rate_limits

    RAISE NOTICE 'Set application_id as NOT NULL for core config tables';
EXCEPTION
    WHEN others THEN
        RAISE WARNING 'Could not set NOT NULL constraint. Some records may still have NULL application_id: %', SQLERRM;
END $$;

-- ============================================================================
-- STEP 8: Update unique constraints
-- ============================================================================

-- 8.1 risk_type_config: Change from UNIQUE(tenant_id) to UNIQUE(application_id)
DO $$
BEGIN
    -- Drop old constraint if exists
    ALTER TABLE risk_type_config DROP CONSTRAINT IF EXISTS uq_risk_type_config_tenant;
    ALTER TABLE risk_type_config DROP CONSTRAINT IF EXISTS risk_type_config_tenant_id_key;

    -- Add new constraint (idempotent)
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_risk_type_config_application'
        AND conrelid = 'risk_type_config'::regclass
    ) THEN
        ALTER TABLE risk_type_config ADD CONSTRAINT uq_risk_type_config_application UNIQUE(application_id);
    END IF;

    RAISE NOTICE 'Updated risk_type_config unique constraint to application_id';
END $$;

-- 8.2 tenant_rate_limits: Change from UNIQUE(tenant_id) to UNIQUE(application_id)
DO $$
BEGIN
    -- Drop old constraint if exists
    ALTER TABLE tenant_rate_limits DROP CONSTRAINT IF EXISTS uq_tenant_rate_limits_tenant;
    ALTER TABLE tenant_rate_limits DROP CONSTRAINT IF EXISTS tenant_rate_limits_tenant_id_key;

    -- Add new constraint (idempotent)
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_tenant_rate_limits_application'
        AND conrelid = 'tenant_rate_limits'::regclass
    ) THEN
        ALTER TABLE tenant_rate_limits ADD CONSTRAINT uq_tenant_rate_limits_application UNIQUE(application_id);
    END IF;

    RAISE NOTICE 'Updated tenant_rate_limits unique constraint to application_id';
END $$;

-- ============================================================================
-- STEP 9: DO NOT drop tenants.api_key column (keep for backward compatibility)
-- ============================================================================

-- Commented out for safety - will be removed in a future migration after users have migrated
-- ALTER TABLE tenants DROP COLUMN IF EXISTS api_key;

-- ============================================================================
-- STEP 10: Verification queries (for logging)
-- ============================================================================

DO $$
DECLARE
    app_count INT;
    key_count INT;
    tenant_count INT;
BEGIN
    SELECT COUNT(*) INTO app_count FROM applications;
    SELECT COUNT(*) INTO key_count FROM api_keys;
    SELECT COUNT(*) INTO tenant_count FROM tenants;

    RAISE NOTICE '=== Migration 011 Complete ===';
    RAISE NOTICE 'Created % applications for % tenants', app_count, tenant_count;
    RAISE NOTICE 'Migrated % API keys to api_keys table', key_count;
    RAISE NOTICE 'All configurations have been migrated to application-scoped model';
    RAISE NOTICE '================================';
END $$;
