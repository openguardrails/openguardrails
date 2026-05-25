-- Migration: 047_add_restore_anonymization
-- Description: Add fields for restore-enabled anonymization (脱敏+还原功能)
-- Date: 2026-01-07

-- Add restore anonymization fields to data_security_entity_types table
ALTER TABLE data_security_entity_types
ADD COLUMN IF NOT EXISTS restore_enabled BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS restore_code TEXT,
ADD COLUMN IF NOT EXISTS restore_code_hash VARCHAR(64),
ADD COLUMN IF NOT EXISTS restore_natural_desc TEXT;

-- Add comment for new columns
COMMENT ON COLUMN data_security_entity_types.restore_enabled IS 'Whether this entity type supports restorable anonymization';
COMMENT ON COLUMN data_security_entity_types.restore_code IS 'AI-generated Python code for anonymization (hidden from user)';
COMMENT ON COLUMN data_security_entity_types.restore_code_hash IS 'SHA-256 hash for code integrity verification';
COMMENT ON COLUMN data_security_entity_types.restore_natural_desc IS 'User natural language description for anonymization rule';
