-- Migration: Add original_content column to detection_results table
-- Description: Stores original unmasked content for admin review and whitelist operations
-- The existing 'content' column stores masked content; original_content stores the pre-masking version
-- Only populated when data masking actually modifies the content

ALTER TABLE detection_results
ADD COLUMN IF NOT EXISTS original_content TEXT;

COMMENT ON COLUMN detection_results.original_content IS 'Original unmasked content before data masking. NULL when no masking was applied (content = original).';
