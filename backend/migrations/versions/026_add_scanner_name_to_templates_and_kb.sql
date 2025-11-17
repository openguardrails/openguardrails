-- Migration: Add scanner_name field to response_templates and knowledge_bases
-- Description: Add scanner_name column to store human-readable scanner names for display
-- Date: 2025-11-17

-- ==========================================
-- 1. Add scanner_name column to response_templates
-- ==========================================

ALTER TABLE response_templates
ADD COLUMN IF NOT EXISTS scanner_name VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_response_templates_scanner_name
ON response_templates(scanner_name)
WHERE scanner_name IS NOT NULL;

COMMENT ON COLUMN response_templates.scanner_name IS 'Human-readable scanner name for display (e.g., "Bank Fraud", "Travel Discussion")';

-- ==========================================
-- 2. Add scanner_name column to knowledge_bases
-- ==========================================

ALTER TABLE knowledge_bases
ADD COLUMN IF NOT EXISTS scanner_name VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_knowledge_bases_scanner_name
ON knowledge_bases(scanner_name)
WHERE scanner_name IS NOT NULL;

COMMENT ON COLUMN knowledge_bases.scanner_name IS 'Human-readable scanner name for display (e.g., "Bank Fraud", "Travel Discussion")';

-- ==========================================
-- 3. Populate scanner_name from related tables
-- ==========================================

-- For blacklist scanner type: get name from blacklist table
UPDATE response_templates rt
SET scanner_name = bl.name
FROM blacklist bl
WHERE
    rt.scanner_type = 'blacklist'
    AND rt.scanner_identifier = bl.name
    AND rt.scanner_name IS NULL;

UPDATE knowledge_bases kb
SET scanner_name = bl.name
FROM blacklist bl
WHERE
    kb.scanner_type = 'blacklist'
    AND kb.scanner_identifier = bl.name
    AND kb.scanner_name IS NULL;

-- For whitelist scanner type: get name from whitelist table
UPDATE response_templates rt
SET scanner_name = wl.name
FROM whitelist wl
WHERE
    rt.scanner_type = 'whitelist'
    AND rt.scanner_identifier = wl.name
    AND rt.scanner_name IS NULL;

UPDATE knowledge_bases kb
SET scanner_name = wl.name
FROM whitelist wl
WHERE
    kb.scanner_type = 'whitelist'
    AND kb.scanner_identifier = wl.name
    AND kb.scanner_name IS NULL;

-- For custom_scanner and marketplace_scanner types: get name from scanners table (via tag)
UPDATE response_templates rt
SET scanner_name = s.name
FROM scanners s
WHERE
    rt.scanner_type IN ('custom_scanner', 'marketplace_scanner', 'official_scanner')
    AND rt.scanner_identifier = s.tag
    AND rt.scanner_name IS NULL;

UPDATE knowledge_bases kb
SET scanner_name = s.name
FROM scanners s
WHERE
    kb.scanner_type IN ('custom_scanner', 'marketplace_scanner', 'official_scanner')
    AND kb.scanner_identifier = s.tag
    AND kb.scanner_name IS NULL;

-- For legacy official_scanner type (S1-S21 not in scanners table): set scanner_name from category mapping
-- Use a DO block to populate official scanner names
DO $$
DECLARE
    category_mapping RECORD;
BEGIN
    -- Map S1-S21 tags to human-readable names
    FOR category_mapping IN
        SELECT unnest(ARRAY['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10',
                            'S11', 'S12', 'S13', 'S14', 'S15', 'S16', 'S17', 'S18', 'S19', 'S20', 'S21']) AS tag,
               unnest(ARRAY[
                   'General Political Topics',
                   'Sensitive Political Topics',
                   'Insult to National Symbols or Leaders',
                   'Harm to Minors',
                   'Violent Crime',
                   'Non-Violent Crime',
                   'Pornography',
                   'Hate & Discrimination',
                   'Prompt Attacks',
                   'Profanity',
                   'Privacy Invasion',
                   'Commercial Violations',
                   'Intellectual Property Infringement',
                   'Harassment',
                   'Weapons of Mass Destruction',
                   'Self-Harm',
                   'Sexual Crimes',
                   'Threats',
                   'Professional Financial Advice',
                   'Professional Medical Advice',
                   'Professional Legal Advice'
               ]) AS name
    LOOP
        -- Update response_templates
        UPDATE response_templates
        SET scanner_name = category_mapping.name
        WHERE
            scanner_type = 'official_scanner'
            AND scanner_identifier = category_mapping.tag
            AND scanner_name IS NULL;

        -- Update knowledge_bases
        UPDATE knowledge_bases
        SET scanner_name = category_mapping.name
        WHERE
            scanner_type = 'official_scanner'
            AND scanner_identifier = category_mapping.tag
            AND scanner_name IS NULL;
    END LOOP;

    RAISE NOTICE 'Populated scanner_name for official scanners (S1-S21)';
END $$;

-- ==========================================
-- Migration complete
-- ==========================================
-- Summary:
-- 1. Added scanner_name column to response_templates and knowledge_bases
-- 2. Created indexes for better query performance
-- 3. Populated scanner_name from related tables (blacklist, whitelist, custom_scanners)
-- 4. Populated scanner_name for official scanners (S1-S21)
--
-- Next steps:
-- - Update database models to include scanner_name field
-- - Update config_api.py to return scanner_name in API responses
-- - Frontend will automatically display scanner_name
