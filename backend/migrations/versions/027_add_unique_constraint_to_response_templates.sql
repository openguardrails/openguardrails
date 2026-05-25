-- Add unique constraint to prevent duplicate response templates
-- This constraint ensures no duplicate templates can be created for the same
-- combination of tenant, application, and scanner (by identifier or name)

-- First clean any remaining duplicates that might exist
DO $$
DECLARE
    duplicate_count INTEGER;
    total_cleaned INTEGER := 0;
BEGIN
    -- Clean duplicates for records with category (legacy format)
    -- Keep the latest record (highest ID) for each unique combination
    CREATE TEMPORARY TABLE category_templates_to_keep AS
    SELECT DISTINCT ON (tenant_id, application_id, category)
        id
    FROM response_templates
    WHERE category IS NOT NULL
    ORDER BY tenant_id, application_id, category, id DESC;

    -- Delete category duplicates
    DELETE FROM response_templates
    WHERE category IS NOT NULL
      AND id NOT IN (SELECT id FROM category_templates_to_keep);

    GET DIAGNOSTICS duplicate_count = ROW_COUNT;
    total_cleaned := total_cleaned + duplicate_count;
    RAISE NOTICE 'Cleaned % duplicate response templates (category-based)', duplicate_count;

    DROP TABLE category_templates_to_keep;

    -- Clean duplicates for records with scanner_identifier (new format)
    CREATE TEMPORARY TABLE scanner_templates_to_keep AS
    SELECT DISTINCT ON (tenant_id, application_id, scanner_identifier)
        id
    FROM response_templates
    WHERE scanner_identifier IS NOT NULL
    ORDER BY tenant_id, application_id, scanner_identifier, id DESC;

    -- Delete scanner_identifier duplicates
    DELETE FROM response_templates
    WHERE scanner_identifier IS NOT NULL
      AND id NOT IN (SELECT id FROM scanner_templates_to_keep);

    GET DIAGNOSTICS duplicate_count = ROW_COUNT;
    total_cleaned := total_cleaned + duplicate_count;
    RAISE NOTICE 'Cleaned % duplicate response templates (scanner_identifier-based)', duplicate_count;

    DROP TABLE scanner_templates_to_keep;

    -- Clean duplicates for records with scanner_name
    CREATE TEMPORARY TABLE scanner_name_templates_to_keep AS
    SELECT DISTINCT ON (tenant_id, application_id, scanner_name)
        id
    FROM response_templates
    WHERE scanner_name IS NOT NULL
    ORDER BY tenant_id, application_id, scanner_name, id DESC;

    -- Delete scanner_name duplicates
    DELETE FROM response_templates
    WHERE scanner_name IS NOT NULL
      AND id NOT IN (SELECT id FROM scanner_name_templates_to_keep);

    GET DIAGNOSTICS duplicate_count = ROW_COUNT;
    total_cleaned := total_cleaned + duplicate_count;
    RAISE NOTICE 'Cleaned % duplicate response templates (scanner_name-based)', duplicate_count;

    DROP TABLE scanner_name_templates_to_keep;

    RAISE NOTICE 'Total cleaned: % duplicate response templates', total_cleaned;
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