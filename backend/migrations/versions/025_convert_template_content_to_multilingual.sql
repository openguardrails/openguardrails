-- Migration: Convert template_content from string to multilingual dictionary format
-- Description: Ensure all response_templates.template_content are in JSON object format {"en": "...", "zh": "..."}
-- Date: 2025-11-17

-- ==========================================
-- Convert template_content from string to multilingual dictionary format
-- ==========================================

-- Convert string template_content to JSON object format {"en": "...", "zh": "..."}
DO $$
DECLARE
    template_record RECORD;
    old_content TEXT;
    new_content JSONB;
    updated_count INTEGER := 0;
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

        updated_count := updated_count + 1;
        RAISE NOTICE 'Updated template ID %: converted to multilingual format', template_record.id;
    END LOOP;

    RAISE NOTICE 'Total templates updated: %', updated_count;
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
-- 1. Converted all string-format template_content to multilingual dictionary format
-- 2. Added column comment to document expected format
-- 3. Verified all templates are in correct format
--
-- This ensures ResponseTemplateResponse Pydantic model validation succeeds
-- Expected format: {"en": "English text", "zh": "中文文本"}
