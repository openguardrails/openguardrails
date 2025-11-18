-- Add unique constraint to prevent duplicate response templates
-- This constraint ensures no duplicate templates can be created for the same
-- combination of tenant, application, and scanner (by identifier or name)

-- First clean any remaining duplicates that might exist
DO $$
DECLARE
    duplicate_count INTEGER;
BEGIN
    -- Create a temporary table to hold the records to keep (latest by ID)
    CREATE TEMPORARY TABLE templates_to_keep AS
    SELECT DISTINCT ON (tenant_id, application_id, COALESCE(scanner_identifier, category))
        id
    FROM response_templates
    WHERE scanner_name IS NOT NULL
    ORDER BY tenant_id, application_id, COALESCE(scanner_identifier, category), id DESC;

    -- Delete duplicates (records not in templates_to_keep)
    DELETE FROM response_templates
    WHERE scanner_name IS NOT NULL
      AND id NOT IN (SELECT id FROM templates_to_keep);

    GET DIAGNOSTICS duplicate_count = ROW_COUNT;
    RAISE NOTICE 'Cleaned % duplicate response templates', duplicate_count;

    -- Drop temporary table
    DROP TABLE templates_to_keep;
END $$;

-- Add unique constraint to prevent future duplicates
-- PostgreSQL doesn't support COALESCE in UNIQUE constraints, so we'll use a functional index
CREATE UNIQUE INDEX IF NOT EXISTS idx_response_templates_unique_tenant_app_scanner
ON response_templates (tenant_id, application_id, COALESCE(scanner_identifier, category))
WHERE scanner_name IS NOT NULL;

-- Add additional partial unique indexes for different field combinations
CREATE UNIQUE INDEX IF NOT EXISTS idx_response_templates_unique_scanner_identifier
ON response_templates (tenant_id, application_id, scanner_identifier)
WHERE scanner_identifier IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_response_templates_unique_category
ON response_templates (tenant_id, application_id, category)
WHERE category IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_response_templates_unique_scanner_name
ON response_templates (tenant_id, application_id, scanner_name)
WHERE scanner_name IS NOT NULL;

COMMENT ON INDEX idx_response_templates_unique_tenant_app_scanner IS
'Unique functional index that prevents duplicate response templates for the same tenant, application, and scanner combination. Uses COALESCE to handle both new format (scanner_identifier) and legacy format (category).';

COMMENT ON INDEX idx_response_templates_unique_scanner_identifier IS
'Unique index for scanner_identifier field to prevent duplicates in new format.';

COMMENT ON INDEX idx_response_templates_unique_category IS
'Unique index for category field to prevent duplicates in legacy format.';

COMMENT ON INDEX idx_response_templates_unique_scanner_name IS
'Additional unique index for scanner_name to prevent duplicates based on display name.';