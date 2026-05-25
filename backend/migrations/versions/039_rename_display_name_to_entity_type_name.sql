-- Migration: rename_display_name_to_entity_type_name
-- Version: 039
-- Date: 2026-01-05
-- Author: Claude

-- Description:
-- Rename display_name column to entity_type_name in data_security_entity_types table
-- for better naming consistency and clarity

-- ============================================================================
-- Rename display_name to entity_type_name
-- ============================================================================

-- Check if old column exists before renaming (idempotent)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name = 'data_security_entity_types'
        AND column_name = 'display_name'
    ) THEN
        ALTER TABLE data_security_entity_types
        RENAME COLUMN display_name TO entity_type_name;

        RAISE NOTICE 'Renamed display_name to entity_type_name in data_security_entity_types table';
    ELSE
        RAISE NOTICE 'Column display_name does not exist, skipping rename (already migrated)';
    END IF;
END $$;
