-- Migration: Add scanner type support for response templates and knowledge base
-- Description: Extend response_templates and knowledge_bases tables to support all scanner types
--              (blacklist, whitelist, official scanners, marketplace scanners, custom scanners)
-- Date: 2025-11-17

-- ==========================================
-- 1. Add new columns to response_templates
-- ==========================================

-- Add scanner_type column (type of scanner: blacklist, whitelist, official_scanner, marketplace_scanner, custom_scanner)
ALTER TABLE response_templates
ADD COLUMN IF NOT EXISTS scanner_type VARCHAR(50);

-- Add scanner_identifier column (blacklist name, whitelist name, or scanner tag like S1, S2, S100, etc.)
ALTER TABLE response_templates
ADD COLUMN IF NOT EXISTS scanner_identifier VARCHAR(255);

-- Make category column nullable (for backward compatibility, keep existing S1-S21 data)
-- Note: PostgreSQL ALTER COLUMN syntax
DO $$
BEGIN
    ALTER TABLE response_templates ALTER COLUMN category DROP NOT NULL;
EXCEPTION
    WHEN others THEN
        -- Column might already be nullable
        NULL;
END $$;

-- Add index on scanner_type for faster queries
CREATE INDEX IF NOT EXISTS idx_response_templates_scanner_type
ON response_templates(scanner_type);

-- Add composite index on scanner_type + scanner_identifier for faster lookups
CREATE INDEX IF NOT EXISTS idx_response_templates_scanner_lookup
ON response_templates(scanner_type, scanner_identifier)
WHERE scanner_type IS NOT NULL AND scanner_identifier IS NOT NULL;

-- ==========================================
-- 2. Add new columns to knowledge_bases
-- ==========================================

-- Add scanner_type column
ALTER TABLE knowledge_bases
ADD COLUMN IF NOT EXISTS scanner_type VARCHAR(50);

-- Add scanner_identifier column
ALTER TABLE knowledge_bases
ADD COLUMN IF NOT EXISTS scanner_identifier VARCHAR(255);

-- Make category column nullable (for backward compatibility)
DO $$
BEGIN
    ALTER TABLE knowledge_bases ALTER COLUMN category DROP NOT NULL;
EXCEPTION
    WHEN others THEN
        NULL;
END $$;

-- Add index on scanner_type for faster queries
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_scanner_type
ON knowledge_bases(scanner_type);

-- Add composite index on scanner_type + scanner_identifier for faster lookups
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_scanner_lookup
ON knowledge_bases(scanner_type, scanner_identifier)
WHERE scanner_type IS NOT NULL AND scanner_identifier IS NOT NULL;

-- ==========================================
-- 3. Migrate existing data (S1-S21 -> official_scanner)
-- ==========================================

-- Migrate existing response_templates with category S1-S21 to official_scanner type
UPDATE response_templates
SET
    scanner_type = 'official_scanner',
    scanner_identifier = category
WHERE
    category IS NOT NULL
    AND category ~ '^S[0-9]+$'  -- Match S1, S2, ..., S21
    AND scanner_type IS NULL;  -- Only migrate if not already set

-- Migrate existing knowledge_bases with category S1-S21 to official_scanner type
UPDATE knowledge_bases
SET
    scanner_type = 'official_scanner',
    scanner_identifier = category
WHERE
    category IS NOT NULL
    AND category ~ '^S[0-9]+$'  -- Match S1, S2, ..., S21
    AND scanner_type IS NULL;  -- Only migrate if not already set

-- ==========================================
-- 4. Add check constraints (optional, for data integrity)
-- ==========================================

-- Ensure scanner_type is one of the allowed values
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'response_templates_scanner_type_check'
    ) THEN
        ALTER TABLE response_templates
        ADD CONSTRAINT response_templates_scanner_type_check
        CHECK (scanner_type IN ('blacklist', 'whitelist', 'official_scanner', 'marketplace_scanner', 'custom_scanner') OR scanner_type IS NULL);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'knowledge_bases_scanner_type_check'
    ) THEN
        ALTER TABLE knowledge_bases
        ADD CONSTRAINT knowledge_bases_scanner_type_check
        CHECK (scanner_type IN ('blacklist', 'whitelist', 'official_scanner', 'marketplace_scanner', 'custom_scanner') OR scanner_type IS NULL);
    END IF;
END $$;

-- Ensure either (category) or (scanner_type + scanner_identifier) is set
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'response_templates_scanner_info_check'
    ) THEN
        ALTER TABLE response_templates
        ADD CONSTRAINT response_templates_scanner_info_check
        CHECK (
            category IS NOT NULL OR
            (scanner_type IS NOT NULL AND scanner_identifier IS NOT NULL)
        );
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'knowledge_bases_scanner_info_check'
    ) THEN
        ALTER TABLE knowledge_bases
        ADD CONSTRAINT knowledge_bases_scanner_info_check
        CHECK (
            category IS NOT NULL OR
            (scanner_type IS NOT NULL AND scanner_identifier IS NOT NULL)
        );
    END IF;
END $$;

-- ==========================================
-- 5. Convert template_content from string to multilingual dictionary format
-- ==========================================

-- Convert string template_content to JSON object format {"en": "...", "zh": "..."}
DO $$
DECLARE
    template_record RECORD;
    old_content TEXT;
    new_content JSONB;
BEGIN
    -- Loop through all templates that have string content (not JSON object)
    FOR template_record IN
        SELECT id, template_content
        FROM response_templates
        WHERE jsonb_typeof(template_content::jsonb) = 'string'
    LOOP
        -- Extract the string value from the JSON string
        old_content := template_record.template_content::jsonb#>>'{}';

        -- Create new multilingual JSON object with both en and zh using the same content
        new_content := jsonb_build_object('en', old_content, 'zh', old_content);

        -- Update the record
        UPDATE response_templates
        SET template_content = new_content
        WHERE id = template_record.id;

        RAISE NOTICE 'Updated template ID %: % -> %', template_record.id, old_content, new_content;
    END LOOP;
END $$;

-- Add comment to document the expected format
COMMENT ON COLUMN response_templates.template_content IS 'Multilingual response template content in JSON format: {"en": "English text", "zh": "中文文本", ...}';

-- Verify all templates now have object format
DO $$
DECLARE
    string_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO string_count
    FROM response_templates
    WHERE jsonb_typeof(template_content::jsonb) = 'string';

    IF string_count > 0 THEN
        RAISE WARNING 'Still % templates with string format after migration', string_count;
    ELSE
        RAISE NOTICE 'All templates successfully migrated to multilingual format';
    END IF;
END $$;

-- ==========================================
-- Migration complete
-- ==========================================
-- Summary:
-- 1. Added scanner_type and scanner_identifier columns to response_templates and knowledge_bases
-- 2. Made category column nullable for backward compatibility
-- 3. Migrated existing S1-S21 data to official_scanner type
-- 4. Added indexes for better query performance
-- 5. Added check constraints for data integrity
-- 6. Converted template_content from string to multilingual dictionary format
--
-- Next steps:
-- - Update backend models (database/models.py)
-- - Update enhanced_template_service.py to support all scanner types
-- - Update detection services to use unified response system
-- - Update frontend UI to configure templates/KB for all scanner types
