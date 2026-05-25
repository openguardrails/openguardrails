-- Migration: Fix recognition_method for genai entity types
-- Version: 057
-- Date: 2026-01-04 (renumbered from 029 to fix duplicate version)
-- Description: Correct recognition_method from 'regex' to 'genai' for entities that have:
--              1. anonymization_method = 'genai', OR
--              2. entity_definition in recognition_config but no pattern

-- ============================================================================
-- STEP 1: Find and fix entities with genai anonymization but regex recognition
-- ============================================================================

DO $$
DECLARE
    fixed_count INTEGER := 0;
    entity_record RECORD;
BEGIN
    RAISE NOTICE 'Starting fix for genai recognition_method...';

    -- Fix entities where anonymization_method is 'genai' but recognition_method is 'regex'
    FOR entity_record IN
        SELECT id, entity_type, entity_type_name, recognition_method, anonymization_method, recognition_config
        FROM data_security_entity_types
        WHERE recognition_method = 'regex'
          AND anonymization_method = 'genai'
    LOOP
        -- Update recognition_method to 'genai'
        UPDATE data_security_entity_types
        SET recognition_method = 'genai',
            updated_at = NOW()
        WHERE id = entity_record.id;

        fixed_count := fixed_count + 1;
        RAISE NOTICE 'Fixed entity: % (%) - changed recognition_method from regex to genai',
            entity_record.entity_type, entity_record.entity_type_name;
    END LOOP;

    RAISE NOTICE 'Fixed % entities with mismatched recognition_method', fixed_count;
END $$;

-- ============================================================================
-- STEP 2: Fix entities that have entity_definition but no pattern
-- ============================================================================

DO $$
DECLARE
    fixed_count INTEGER := 0;
    entity_record RECORD;
    has_pattern BOOLEAN;
    has_entity_definition BOOLEAN;
BEGIN
    RAISE NOTICE 'Checking entities with entity_definition in recognition_config...';

    -- Fix entities where recognition_config has entity_definition but recognition_method is 'regex'
    FOR entity_record IN
        SELECT id, entity_type, entity_type_name, recognition_method, recognition_config
        FROM data_security_entity_types
        WHERE recognition_method = 'regex'
          AND recognition_config IS NOT NULL
    LOOP
        -- Check if recognition_config has entity_definition
        has_entity_definition := (entity_record.recognition_config->>'entity_definition') IS NOT NULL
                                 AND (entity_record.recognition_config->>'entity_definition') != '';
        has_pattern := (entity_record.recognition_config->>'pattern') IS NOT NULL
                       AND (entity_record.recognition_config->>'pattern') != ''
                       AND (entity_record.recognition_config->>'pattern') != 'null';

        -- If has entity_definition but no valid pattern, it should be genai type
        IF has_entity_definition AND NOT has_pattern THEN
            UPDATE data_security_entity_types
            SET recognition_method = 'genai',
                anonymization_method = 'genai',
                updated_at = NOW()
            WHERE id = entity_record.id;

            fixed_count := fixed_count + 1;
            RAISE NOTICE 'Fixed entity: % (%) - changed to genai based on entity_definition',
                entity_record.entity_type, entity_record.entity_type_name;
        END IF;
    END LOOP;

    RAISE NOTICE 'Fixed % additional entities based on recognition_config', fixed_count;
END $$;

-- ============================================================================
-- STEP 3: Verification
-- ============================================================================

DO $$
DECLARE
    genai_count INTEGER;
    mismatched_count INTEGER;
BEGIN
    -- Count genai entities
    SELECT COUNT(*) INTO genai_count
    FROM data_security_entity_types
    WHERE recognition_method = 'genai';

    -- Check for any remaining mismatches
    SELECT COUNT(*) INTO mismatched_count
    FROM data_security_entity_types
    WHERE recognition_method = 'regex' AND anonymization_method = 'genai';

    RAISE NOTICE '=== Migration 057 Complete ===';
    RAISE NOTICE 'Total genai entities: %', genai_count;
    RAISE NOTICE 'Remaining mismatches: %', mismatched_count;

    IF mismatched_count > 0 THEN
        RAISE WARNING 'There are still % entities with mismatched recognition/anonymization methods', mismatched_count;
    ELSE
        RAISE NOTICE 'All genai entity types are now correctly configured';
    END IF;
    RAISE NOTICE '================================';
END $$;
