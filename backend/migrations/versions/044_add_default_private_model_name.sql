-- Migration 044: Add default_private_model_name to upstream_api_configs
-- This allows specifying which exact model name to use when a provider is the default private model
-- For example, if a provider has models ["gpt-4", "gpt-4-turbo"], user can specify "gpt-4" as the default

-- Add the new column
ALTER TABLE upstream_api_configs
ADD COLUMN IF NOT EXISTS default_private_model_name VARCHAR(255);

-- Add a comment explaining the column
COMMENT ON COLUMN upstream_api_configs.default_private_model_name IS
'The specific model name to use when this provider is the default private model. Should be one of the values in private_model_names.';
