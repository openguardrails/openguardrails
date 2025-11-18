-- Add model_name column to online_test_model_selections table
-- This allows users to specify custom model names for proxy testing

ALTER TABLE online_test_model_selections
ADD COLUMN IF NOT EXISTS model_name VARCHAR(200);

COMMENT ON COLUMN online_test_model_selections.model_name IS 'Model name specified by user for testing (e.g., gpt-4, claude-3-5-sonnet-20241022, openrouter model names)';












