-- Migration: Refactor Anonymization Methods
-- Date: 2026-01-10
-- Description:
--   1. Remove restore_enabled field from data_security_entity_types (now determined by policy action)
--   2. Rename 'genai' anonymization method to 'genai_natural'
--   3. Add 'genai_code' as a valid anonymization method

-- Step 1: Rename 'genai' to 'genai_natural' in existing data
UPDATE data_security_entity_types
SET anonymization_method = 'genai_natural'
WHERE anonymization_method = 'genai';

-- Step 2: Drop restore_enabled column if exists
-- The restore behavior is now determined by the disposal action (anonymize vs anonymize_restore)
-- and is not configured per-entity-type
ALTER TABLE data_security_entity_types
DROP COLUMN IF EXISTS restore_enabled;

-- Step 3: Update any entity types that have restore_code but were using a different method
-- These should now use 'genai_code' method to leverage their generated code
UPDATE data_security_entity_types
SET anonymization_method = 'genai_code'
WHERE restore_code IS NOT NULL
  AND restore_code != ''
  AND restore_code_hash IS NOT NULL
  AND anonymization_method NOT IN ('genai_code', 'genai_natural');

-- Note: The following columns are retained for genai_code method:
--   - restore_code: The AI-generated Python code for anonymization
--   - restore_code_hash: Hash for secure code execution verification
--   - restore_natural_desc: Natural language description used to generate the code
