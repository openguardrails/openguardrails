-- Migration: add_english_content_to_response_templates
-- Version: 015
-- Date: 2025-11-04
-- Author: Claude Code Assistant

-- Description:
-- Add English content to existing response templates that only have Chinese content.
-- This migration adds default English translations for all risk categories.

-- Default English content for each category
DO $$
DECLARE
    template_record RECORD;
    new_content JSONB;
    english_text TEXT;
    template_count INTEGER;
BEGIN
    -- Check if response_templates table has any data
    SELECT COUNT(*) INTO template_count FROM response_templates;

    IF template_count = 0 THEN
        RAISE NOTICE 'No response templates found, skipping migration 015';
        RETURN;
    END IF;

    -- Loop through all response templates
    FOR template_record IN
        SELECT id, category, template_content::jsonb as template_content
        FROM response_templates
        WHERE (template_content::jsonb) ? 'zh' AND NOT ((template_content::jsonb) ? 'en')
    LOOP
        -- Determine English content based on category
        -- Format: "Request blocked by OpenGuardrails due to content potentially involving [topic]."
        CASE template_record.category
            WHEN 'S1' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving general political topics.';
            WHEN 'S2' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving sensitive political topics.';
            WHEN 'S3' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving insult to national symbols or leaders.';
            WHEN 'S4' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving harm to minors.';
            WHEN 'S5' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving violent crime.';
            WHEN 'S6' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving non-violent crime.';
            WHEN 'S7' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving pornography.';
            WHEN 'S8' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving hate and discrimination.';
            WHEN 'S9' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving prompt injection attacks.';
            WHEN 'S10' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving profanity.';
            WHEN 'S11' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving privacy invasion.';
            WHEN 'S12' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving commercial violations.';
            WHEN 'S13' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving intellectual property infringement.';
            WHEN 'S14' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving harassment.';
            WHEN 'S15' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving weapons of mass destruction.';
            WHEN 'S16' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving self-harm.';
            WHEN 'S17' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving sexual crimes.';
            WHEN 'S18' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving threats.';
            WHEN 'S19' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving professional financial advice.';
            WHEN 'S20' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving professional medical advice.';
            WHEN 'S21' THEN
                english_text := 'Request blocked by OpenGuardrails due to content potentially involving professional legal advice.';
            WHEN 'default' THEN
                english_text := 'Request blocked by OpenGuardrails due to content policy violation.';
            ELSE
                english_text := 'Request blocked by OpenGuardrails due to content policy violation.';
        END CASE;

        -- Add English content to existing JSONB
        new_content := jsonb_set(
            template_record.template_content,
            '{en}',
            to_jsonb(english_text)
        );

        -- Update the record
        UPDATE response_templates
        SET template_content = new_content,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = template_record.id;

        RAISE NOTICE 'Added English content to template ID % (category: %)', template_record.id, template_record.category;
    END LOOP;

    RAISE NOTICE 'Migration completed: Added English content to response templates';
END $$;
