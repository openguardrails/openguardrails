-- Migration: Rename scanner_name to guardrail_name
-- Description: Rename scanner_name column to guardrail_name in response_templates and knowledge_bases tables,
--              update indexes, and update template data containing {scanner_name} placeholder to {guardrail_name}

-- 1. Rename column in response_templates
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'response_templates' AND column_name = 'scanner_name'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'response_templates' AND column_name = 'guardrail_name'
    ) THEN
        ALTER TABLE response_templates RENAME COLUMN scanner_name TO guardrail_name;
        RAISE NOTICE 'Renamed response_templates.scanner_name to guardrail_name';
    END IF;
END $$;

-- 2. Rename column in knowledge_bases
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'knowledge_bases' AND column_name = 'scanner_name'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'knowledge_bases' AND column_name = 'guardrail_name'
    ) THEN
        ALTER TABLE knowledge_bases RENAME COLUMN scanner_name TO guardrail_name;
        RAISE NOTICE 'Renamed knowledge_bases.scanner_name to guardrail_name';
    END IF;
END $$;

-- 3. Rename indexes on response_templates
DROP INDEX IF EXISTS idx_response_templates_scanner_name;
CREATE INDEX IF NOT EXISTS idx_response_templates_guardrail_name
ON response_templates(guardrail_name)
WHERE guardrail_name IS NOT NULL;

DROP INDEX IF EXISTS idx_response_templates_unique_scanner_name;
CREATE UNIQUE INDEX IF NOT EXISTS idx_response_templates_unique_guardrail_name
ON response_templates (tenant_id, application_id, guardrail_name)
WHERE guardrail_name IS NOT NULL;

-- 4. Rename indexes on knowledge_bases
DROP INDEX IF EXISTS idx_knowledge_bases_scanner_name;
CREATE INDEX IF NOT EXISTS idx_knowledge_bases_guardrail_name
ON knowledge_bases(guardrail_name)
WHERE guardrail_name IS NOT NULL;

-- 5. Update template data: replace {scanner_name} with {guardrail_name} in response_templates
UPDATE response_templates
SET template_content = REPLACE(template_content::text, '{scanner_name}', '{guardrail_name}')::jsonb
WHERE template_content::text LIKE '%{scanner_name}%';

-- 6. Update application_settings: replace {scanner_name} with {guardrail_name} in security_risk_template
UPDATE application_settings
SET security_risk_template = REPLACE(security_risk_template::text, '{scanner_name}', '{guardrail_name}')::jsonb
WHERE security_risk_template::text LIKE '%{scanner_name}%';

-- 7. Update column comments
COMMENT ON COLUMN response_templates.guardrail_name IS 'Human-readable guardrail name for display (e.g., "Bank Fraud", "Travel Discussion")';
COMMENT ON COLUMN knowledge_bases.guardrail_name IS 'Human-readable guardrail name for display (e.g., "Bank Fraud", "Travel Discussion")';

COMMENT ON INDEX idx_response_templates_unique_guardrail_name IS
'Unique index for guardrail_name to prevent duplicates based on display name.';
