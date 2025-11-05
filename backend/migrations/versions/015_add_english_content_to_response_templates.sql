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
BEGIN
    -- Loop through all response templates
    FOR template_record IN
        SELECT id, category, template_content
        FROM response_templates
        WHERE template_content ? 'zh' AND NOT (template_content ? 'en')
    LOOP
        -- Determine English content based on category
        CASE template_record.category
            WHEN 'S1' THEN
                english_text := 'Sorry, I cannot answer questions involving general political topics. If you have other questions, I''d be happy to help.';
            WHEN 'S2' THEN
                english_text := 'Sorry, I cannot answer questions involving sensitive political topics. If you have other questions, I''d be happy to help.';
            WHEN 'S3' THEN
                english_text := 'Sorry, I cannot answer questions that may damage national image. If you have other questions, I''d be happy to help.';
            WHEN 'S4' THEN
                english_text := 'Sorry, I cannot answer questions that may harm minors. If you have other questions, I''d be happy to help.';
            WHEN 'S5' THEN
                english_text := 'Sorry, I cannot answer questions involving violent crime. If you have other questions, I''d be happy to help.';
            WHEN 'S6' THEN
                english_text := 'Sorry, I cannot answer questions involving illegal activities. If you have other questions, I''d be happy to help.';
            WHEN 'S7' THEN
                english_text := 'Sorry, I cannot answer questions involving pornographic content. If you have other questions, I''d be happy to help.';
            WHEN 'S8' THEN
                english_text := 'Sorry, I cannot answer questions involving discriminatory content. If you have other questions, I''d be happy to help.';
            WHEN 'S9' THEN
                english_text := 'Sorry, I cannot answer questions involving prompt injection attacks. If you have other questions, I''d be happy to help.';
            WHEN 'S10' THEN
                english_text := 'Sorry, I cannot answer questions involving insulting content. If you have other questions, I''d be happy to help.';
            WHEN 'S11' THEN
                english_text := 'Sorry, I cannot answer questions involving personal privacy. If you have other questions, I''d be happy to help.';
            WHEN 'S12' THEN
                english_text := 'Sorry, I cannot answer questions involving business violations. If you have other questions, I''d be happy to help.';
            WHEN 'S13' THEN
                english_text := 'Sorry, I cannot answer questions involving intellectual property infringement. If you have other questions, I''d be happy to help.';
            WHEN 'S14' THEN
                english_text := 'Sorry, I cannot answer questions involving harassment. If you have other questions, I''d be happy to help.';
            WHEN 'S15' THEN
                english_text := 'Sorry, I cannot answer questions involving weapons of mass destruction. If you have other questions, I''d be happy to help.';
            WHEN 'S16' THEN
                english_text := 'Sorry, I cannot answer questions involving self-harm. If you have other questions, I''d be happy to help.';
            WHEN 'S17' THEN
                english_text := 'Sorry, I cannot answer questions involving sexual crimes. If you have other questions, I''d be happy to help.';
            WHEN 'S18' THEN
                english_text := 'Sorry, I cannot answer questions involving threats. If you have other questions, I''d be happy to help.';
            WHEN 'S19' THEN
                english_text := 'Sorry, I cannot provide professional financial advice. For specific financial decisions, please consult a qualified financial advisor. If you have other questions, I''d be happy to help.';
            WHEN 'S20' THEN
                english_text := 'Sorry, I cannot provide professional medical advice. For health concerns, please consult a qualified healthcare provider. If you have other questions, I''d be happy to help.';
            WHEN 'S21' THEN
                english_text := 'Sorry, I cannot provide professional legal advice. For legal matters, please consult a qualified attorney. If you have other questions, I''d be happy to help.';
            WHEN 'default' THEN
                english_text := 'Sorry, I cannot answer this question. If you have other questions, I''d be happy to help.';
            ELSE
                english_text := 'Sorry, I cannot answer this question. If you have other questions, I''d be happy to help.';
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
