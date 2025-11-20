-- Migration: Fix application_id constraint for global system templates in data_security_entity_types
-- Version: 028
-- Date: 2025-11-19
-- Description: Allow NULL application_id for global system templates (source_type='system_template')
--              This fixes the constraint violation that prevents creation of global entity types

-- ============================================================================
-- STEP 1: Make application_id nullable for global system templates
-- ============================================================================

-- First, let's check if there are any existing records that would be affected
DO $$
DECLARE
    affected_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO affected_count
    FROM data_security_entity_types
    WHERE source_type = 'system_template' AND application_id IS NOT NULL;

    IF affected_count > 0 THEN
        RAISE NOTICE 'Found % system_template records with non-null application_id - this should not happen', affected_count;
    ELSE
        RAISE NOTICE 'No conflicting system_template records found';
    END IF;
END $$;

-- ============================================================================
-- STEP 2: Remove the NOT NULL constraint to allow NULL for global templates
-- ============================================================================

DO $$
BEGIN
    -- Remove the NOT NULL constraint from application_id
    -- This will allow NULL values for global system templates
    ALTER TABLE data_security_entity_types ALTER COLUMN application_id DROP NOT NULL;

    RAISE NOTICE 'Removed NOT NULL constraint from data_security_entity_types.application_id';
EXCEPTION
    WHEN others THEN
        -- If constraint doesn't exist or other error, continue
        RAISE NOTICE 'Could not remove NOT NULL constraint (may not exist): %', SQLERRM;
END $$;

-- ============================================================================
-- STEP 3: Create global system entity type templates
-- ============================================================================

-- Get the super admin tenant ID to use as the creator
DO $$
DECLARE
    admin_tenant_id UUID;
    created_count INTEGER := 0;
BEGIN
    -- Find super admin tenant
    SELECT id INTO admin_tenant_id
    FROM tenants
    WHERE is_super_admin = true
    LIMIT 1;

    IF admin_tenant_id IS NULL THEN
        RAISE WARNING 'No super admin tenant found - cannot create system templates';
        RETURN;
    END IF;

    RAISE NOTICE 'Creating global system entity types for admin tenant: %', admin_tenant_id;

    -- Insert US Bank Number template (the one that was failing)
    INSERT INTO data_security_entity_types (
        id,
        tenant_id,
        application_id,  -- NULL for global templates
        entity_type,
        display_name,
        category,
        recognition_method,
        recognition_config,
        anonymization_method,
        anonymization_config,
        is_active,
        is_global,
        source_type,
        template_id
    ) SELECT
        gen_random_uuid(),
        admin_tenant_id,
        NULL,  -- NULL for global system templates
        'US_BANK_NUMBER_SYS',
        'US BANK NUMBER',
        'medium',
        'regex',
        '{"pattern": "\\\\d{8,19}", "check_input": true, "check_output": true}',
        'replace',
        '{}',
        true,
        true,
        'system_template',
        NULL
    WHERE NOT EXISTS (
        SELECT 1 FROM data_security_entity_types
        WHERE entity_type = 'US_BANK_NUMBER_SYS' AND source_type = 'system_template'
    );

    IF FOUND THEN
        created_count := created_count + 1;
    END IF;

    -- Insert other common system templates
    INSERT INTO data_security_entity_types (
        id,
        tenant_id,
        application_id,  -- NULL for global templates
        entity_type,
        display_name,
        category,
        recognition_method,
        recognition_config,
        anonymization_method,
        anonymization_config,
        is_active,
        is_global,
        source_type,
        template_id
    ) SELECT
        gen_random_uuid(),
        admin_tenant_id,
        NULL,  -- NULL for global system templates
        'ID_CARD_NUMBER_SYS',
        'ID Card Number',
        'high',
        'regex',
        '{"pattern": "[1-8]\\\\d{5}(19|20)\\\\d{2}((0[1-9])|(1[0-2]))((0[1-9])|([12]\\\\d)|(3[01]))\\\\d{3}[\\\\dxX]", "check_input": true, "check_output": true}',
        'mask',
        '{"mask_char": "*", "keep_prefix": 3, "keep_suffix": 4}',
        true,
        true,
        'system_template',
        NULL
    WHERE NOT EXISTS (
        SELECT 1 FROM data_security_entity_types
        WHERE entity_type = 'ID_CARD_NUMBER_SYS' AND source_type = 'system_template'
    );

    IF FOUND THEN
        created_count := created_count + 1;
    END IF;

    INSERT INTO data_security_entity_types (
        id,
        tenant_id,
        application_id,  -- NULL for global templates
        entity_type,
        display_name,
        category,
        recognition_method,
        recognition_config,
        anonymization_method,
        anonymization_config,
        is_active,
        is_global,
        source_type,
        template_id
    ) SELECT
        gen_random_uuid(),
        admin_tenant_id,
        NULL,  -- NULL for global system templates
        'PHONE_NUMBER_SYS',
        'Phone Number',
        'medium',
        'regex',
        '{"pattern": "1[3-9]\\\\d{9}", "check_input": true, "check_output": true}',
        'mask',
        '{"mask_char": "*", "keep_prefix": 3, "keep_suffix": 4}',
        true,
        true,
        'system_template',
        NULL
    WHERE NOT EXISTS (
        SELECT 1 FROM data_security_entity_types
        WHERE entity_type = 'PHONE_NUMBER_SYS' AND source_type = 'system_template'
    );

    IF FOUND THEN
        created_count := created_count + 1;
    END IF;

    INSERT INTO data_security_entity_types (
        id,
        tenant_id,
        application_id,  -- NULL for global templates
        entity_type,
        display_name,
        category,
        recognition_method,
        recognition_config,
        anonymization_method,
        anonymization_config,
        is_active,
        is_global,
        source_type,
        template_id
    ) SELECT
        gen_random_uuid(),
        admin_tenant_id,
        NULL,  -- NULL for global system templates
        'EMAIL_SYS',
        'Email',
        'low',
        'regex',
        '{"pattern": "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\\\.[a-zA-Z]{2,}", "check_input": true, "check_output": true}',
        'mask',
        '{"mask_char": "*", "keep_prefix": 2, "keep_suffix": 0}',
        true,
        true,
        'system_template',
        NULL
    WHERE NOT EXISTS (
        SELECT 1 FROM data_security_entity_types
        WHERE entity_type = 'EMAIL_SYS' AND source_type = 'system_template'
    );

    IF FOUND THEN
        created_count := created_count + 1;
    END IF;

    RAISE NOTICE 'Created % global system entity type templates', created_count;

END $$;

-- ============================================================================
-- STEP 4: Verification
-- ============================================================================

DO $$
DECLARE
    template_count INTEGER;
    global_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO template_count
    FROM data_security_entity_types
    WHERE source_type = 'system_template';

    SELECT COUNT(*) INTO global_count
    FROM data_security_entity_types
    WHERE is_global = true;

    RAISE NOTICE '=== Migration 028 Complete ===';
    RAISE NOTICE 'System templates: %', template_count;
    RAISE NOTICE 'Global entity types: %', global_count;
    RAISE NOTICE 'application_id constraint now allows NULL for global templates';
    RAISE NOTICE '================================';
END $$;