-- Migration: Rebuild built-in data security entity types with language-aware config
-- Version: 068
-- Date: 2026-03-24
-- Description: Delete old system_template entity types (and their system_copy children)
--              so they can be re-created by the application with proper language-specific
--              patterns. Fixes false positives in bank card detection (\d{16,19} was too broad).

-- ============================================================================
-- STEP 1: Delete system_copy entity types (children of system templates)
-- ============================================================================

DO $$
DECLARE
    deleted_copies INTEGER := 0;
    deleted_templates INTEGER := 0;
BEGIN
    -- Delete system_copy entity types first (they reference templates)
    DELETE FROM data_security_entity_types
    WHERE source_type = 'system_copy'
    AND template_id IN (
        SELECT id FROM data_security_entity_types WHERE source_type = 'system_template'
    );
    GET DIAGNOSTICS deleted_copies = ROW_COUNT;
    RAISE NOTICE 'Deleted % system_copy entity types', deleted_copies;

    -- Delete system_template entity types
    DELETE FROM data_security_entity_types
    WHERE source_type = 'system_template';
    GET DIAGNOSTICS deleted_templates = ROW_COUNT;
    RAISE NOTICE 'Deleted % system_template entity types', deleted_templates;

    -- Also delete legacy global entity types that don't have source_type set
    DELETE FROM data_security_entity_types
    WHERE is_global = true
    AND (source_type IS NULL OR source_type = '');

    RAISE NOTICE 'Migration 068: Cleared old system entity types. They will be re-created on next startup with language-aware configuration.';
END $$;
