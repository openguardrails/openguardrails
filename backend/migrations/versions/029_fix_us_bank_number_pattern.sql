-- Migration: Fix US_BANK_NUMBER_SYS pattern to support 19-digit bank numbers
-- Version: 029
-- Date: 2025-11-20
-- Description: Update the regex pattern for US_BANK_NUMBER_SYS from \d{8,17} to \d{8,19}
--              to properly match bank card numbers with up to 19 digits

-- ============================================================================
-- STEP 1: Update the pattern in existing records
-- ============================================================================

DO $$
DECLARE
    updated_count INTEGER := 0;
BEGIN
    -- Update all US_BANK_NUMBER_SYS records to use the corrected pattern
    -- Cast json to jsonb for processing, then cast back to json
    -- Note: Pattern in DB is stored with single backslash: \d{8,17}
    UPDATE data_security_entity_types
    SET recognition_config = jsonb_set(
        recognition_config::jsonb,
        '{pattern}',
        to_jsonb('\d{8,19}'::text)
    )::json
    WHERE entity_type = 'US_BANK_NUMBER_SYS'
    AND (recognition_config->>'pattern' = '\d{8,17}' OR recognition_config->>'pattern' = '\\d{8,17}');
    
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    
    RAISE NOTICE 'Updated % US_BANK_NUMBER_SYS records with corrected pattern', updated_count;
    
    IF updated_count = 0 THEN
        RAISE NOTICE 'No records needed updating (pattern may already be correct)';
    END IF;
    
EXCEPTION
    WHEN others THEN
        RAISE WARNING 'Error updating US_BANK_NUMBER_SYS pattern: %', SQLERRM;
        RAISE;
END $$;

-- ============================================================================
-- STEP 2: Verification
-- ============================================================================

DO $$
DECLARE
    correct_pattern_count INTEGER;
    old_pattern_count INTEGER;
BEGIN
    -- Count records with the new correct pattern
    SELECT COUNT(*) INTO correct_pattern_count
    FROM data_security_entity_types
    WHERE entity_type = 'US_BANK_NUMBER_SYS'
    AND recognition_config->>'pattern' = '\d{8,19}';
    
    -- Count records still with the old pattern
    SELECT COUNT(*) INTO old_pattern_count
    FROM data_security_entity_types
    WHERE entity_type = 'US_BANK_NUMBER_SYS'
    AND recognition_config->>'pattern' = '\d{8,17}';
    
    RAISE NOTICE '=== Migration 029 Complete ===';
    RAISE NOTICE 'Records with correct pattern (\d{8,19}): %', correct_pattern_count;
    RAISE NOTICE 'Records with old pattern (\d{8,17}): %', old_pattern_count;
    
    IF old_pattern_count > 0 THEN
        RAISE WARNING 'Some records still have the old pattern - manual review may be needed';
    END IF;
    
    RAISE NOTICE '================================';
END $$;

