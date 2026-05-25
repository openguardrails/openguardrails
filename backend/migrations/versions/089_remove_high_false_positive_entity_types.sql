-- Migration: Remove high false positive entity types
-- Version: 089
-- Date: 2026-04-06
-- Description: Remove CN_BANK_CARD_NUMBER_SYS, US_SSN_SYS, and US_BANK_CARD_NUMBER_SYS
--              entity types due to high false positive rates. Users can manually create
--              these entity types if needed with more precise patterns.

-- ============================================================================
-- Delete system entity types that cause high false positives
-- ============================================================================

DO $$
DECLARE
    deleted_copies INTEGER := 0;
    deleted_templates INTEGER := 0;
BEGIN
    -- Delete system_copy entity types first (they reference templates)
    DELETE FROM data_security_entity_types
    WHERE source_type = 'system_copy'
    AND entity_type IN ('CN_BANK_CARD_NUMBER_SYS', 'US_SSN_SYS', 'US_BANK_CARD_NUMBER_SYS');
    GET DIAGNOSTICS deleted_copies = ROW_COUNT;
    RAISE NOTICE 'Deleted % system_copy entity types for bank card/SSN', deleted_copies;

    -- Delete system_template entity types
    DELETE FROM data_security_entity_types
    WHERE source_type = 'system_template'
    AND entity_type IN ('CN_BANK_CARD_NUMBER_SYS', 'US_SSN_SYS', 'US_BANK_CARD_NUMBER_SYS');
    GET DIAGNOSTICS deleted_templates = ROW_COUNT;
    RAISE NOTICE 'Deleted % system_template entity types for bank card/SSN', deleted_templates;

    -- Also delete any legacy global entity types with these names
    DELETE FROM data_security_entity_types
    WHERE is_global = true
    AND entity_type IN ('CN_BANK_CARD_NUMBER_SYS', 'US_SSN_SYS', 'US_BANK_CARD_NUMBER_SYS');

    RAISE NOTICE 'Migration 089: Removed high false positive entity types (bank cards, SSN)';
END $$;
