-- Migration: Add final reviewer support to appeal system
-- Description: Adds final reviewer email to appeal_config and human review fields to appeal_records
-- Version: 050
-- Date: 2026-01-09

-- Add final reviewer email to appeal_config
ALTER TABLE appeal_config ADD COLUMN IF NOT EXISTS final_reviewer_email VARCHAR(255);

-- Add human review fields to appeal_records
ALTER TABLE appeal_records ADD COLUMN IF NOT EXISTS processor_type VARCHAR(20);
ALTER TABLE appeal_records ADD COLUMN IF NOT EXISTS processor_id VARCHAR(255);
ALTER TABLE appeal_records ADD COLUMN IF NOT EXISTS processor_reason TEXT;
ALTER TABLE appeal_records ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
ALTER TABLE appeal_records ADD COLUMN IF NOT EXISTS content_hash VARCHAR(64);

-- Add indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_appeal_records_content_hash ON appeal_records(content_hash);
CREATE INDEX IF NOT EXISTS idx_appeal_records_processed_at ON appeal_records(processed_at);
CREATE INDEX IF NOT EXISTS idx_appeal_records_processor_type ON appeal_records(processor_type);

-- Add comment
COMMENT ON COLUMN appeal_config.final_reviewer_email IS 'Email address for human final review when AI rejects appeal';
COMMENT ON COLUMN appeal_records.processor_type IS 'Who processed the appeal: agent or human';
COMMENT ON COLUMN appeal_records.processor_id IS 'Human reviewer identifier (email prefix)';
COMMENT ON COLUMN appeal_records.processor_reason IS 'Human reviewer reason (optional)';
COMMENT ON COLUMN appeal_records.processed_at IS 'When the appeal was finally processed';
COMMENT ON COLUMN appeal_records.content_hash IS 'SHA256 hash of content for duplicate detection';
