-- Migration: Fix US_BANK_NUMBER_SYS pattern in all records (templates and copies)
-- Version: 030
-- Date: 2025-11-20
-- Description: Update the regex pattern for US_BANK_NUMBER_SYS from \d{8,17} to \d{8,19}
--              in ALL records including system templates, system copies, and custom instances

-- ============================================================================
-- STEP 1: Update ALL US_BANK_NUMBER_SYS records
-- ============================================================================

DO $$
DECLARE
    updated_count INTEGER := 0;
    total_count INTEGER := 0;
BEGIN
    -- Count total records before update
    SELECT COUNT(*) INTO total_count
    FROM data_security_entity_types
    WHERE entity_type = 'US_BANK_NUMBER_SYS';
    
    RAISE NOTICE 'Found % total US_BANK_NUMBER_SYS records', total_count;
    
    -- Update ALL US_BANK_NUMBER_SYS records regardless of source_type
    -- This includes system_template, system_copy, and any custom instances
    UPDATE data_security_entity_types
    SET recognition_config = jsonb_set(
        recognition_config::jsonb,
        '{pattern}',
        to_jsonb('\d{8,19}'::text)
    )::json
    WHERE entity_type = 'US_BANK_NUMBER_SYS'
    AND (
        recognition_config->>'pattern' = '\d{8,17}' 
        OR recognition_config->>'pattern' = '\\d{8,17}'
        OR recognition_config->>'pattern' LIKE '%8,17%'
    );
    
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    
    RAISE NOTICE 'Updated % US_BANK_NUMBER_SYS records with corrected pattern', updated_count;
    
    IF updated_count = 0 THEN
        RAISE NOTICE 'No records needed updating (pattern may already be correct)';
    ELSIF updated_count < total_count THEN
        RAISE NOTICE '% records were already correct', (total_count - updated_count);
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
    total_count INTEGER;
    template_correct INTEGER;
    copy_correct INTEGER;
BEGIN
    -- Count total records
    SELECT COUNT(*) INTO total_count
    FROM data_security_entity_types
    WHERE entity_type = 'US_BANK_NUMBER_SYS';
    
    -- Count records with the new correct pattern
    SELECT COUNT(*) INTO correct_pattern_count
    FROM data_security_entity_types
    WHERE entity_type = 'US_BANK_NUMBER_SYS'
    AND recognition_config->>'pattern' = '\d{8,19}';
    
    -- Count records still with the old pattern
    SELECT COUNT(*) INTO old_pattern_count
    FROM data_security_entity_types
    WHERE entity_type = 'US_BANK_NUMBER_SYS'
    AND (
        recognition_config->>'pattern' = '\d{8,17}'
        OR recognition_config->>'pattern' LIKE '%8,17%'
    );
    
    -- Count templates with correct pattern
    SELECT COUNT(*) INTO template_correct
    FROM data_security_entity_types
    WHERE entity_type = 'US_BANK_NUMBER_SYS'
    AND source_type = 'system_template'
    AND recognition_config->>'pattern' = '\d{8,19}';
    
    -- Count copies with correct pattern
    SELECT COUNT(*) INTO copy_correct
    FROM data_security_entity_types
    WHERE entity_type = 'US_BANK_NUMBER_SYS'
    AND source_type = 'system_copy'
    AND recognition_config->>'pattern' = '\d{8,19}';
    
    RAISE NOTICE '=== Migration 030 Complete ===';
    RAISE NOTICE 'Total US_BANK_NUMBER_SYS records: %', total_count;
    RAISE NOTICE 'Records with correct pattern (\d{8,19}): %', correct_pattern_count;
    RAISE NOTICE 'Records with old pattern (\d{8,17}): %', old_pattern_count;
    RAISE NOTICE 'System templates corrected: %', template_correct;
    RAISE NOTICE 'System copies corrected: %', copy_correct;
    
    IF old_pattern_count > 0 THEN
        RAISE WARNING 'Some records still have the old pattern - manual review may be needed';
    ELSE
        RAISE NOTICE 'All records successfully updated!';
    END IF;
    
    RAISE NOTICE '================================';
END $$;

