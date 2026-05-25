-- Migration: Add full_messages column to detection_results table
-- Version: 092
-- Description: Stores the complete original messages array for audit purposes.
--              Includes system prompts, full long content, tool_calls and tool results,
--              before any role filtering or sliding-window truncation.
--              Image base64 payloads are stripped to keep the row size sane.

ALTER TABLE detection_results
ADD COLUMN IF NOT EXISTS full_messages JSONB DEFAULT NULL;

COMMENT ON COLUMN detection_results.full_messages IS 'Complete original messages array for audit (system + user/assistant + tool_calls + tool results). Image base64 payloads are stripped.';
