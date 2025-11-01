-- Migration: add_similarity_threshold_to_knowledge_bases
-- Version: 009
-- Date: 2025-10-31
-- Author: System

-- Description:
-- Add similarity_threshold column to knowledge_bases table to allow per-KB similarity threshold configuration
-- Default value is 0.7 (same as the global EMBEDDING_SIMILARITY_THRESHOLD default)

-- Add similarity_threshold column with default value
ALTER TABLE knowledge_bases
ADD COLUMN IF NOT EXISTS similarity_threshold FLOAT DEFAULT 0.7 NOT NULL;

-- Add check constraint to ensure threshold is between 0 and 1
-- PostgreSQL doesn't support IF NOT EXISTS for ADD CONSTRAINT, so we use DO block
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'check_similarity_threshold_range'
    ) THEN
        ALTER TABLE knowledge_bases
        ADD CONSTRAINT check_similarity_threshold_range
        CHECK (similarity_threshold >= 0 AND similarity_threshold <= 1);
    END IF;
END $$;

-- Update existing records to use the default value (0.7)
UPDATE knowledge_bases
SET similarity_threshold = 0.7
WHERE similarity_threshold IS NULL;
