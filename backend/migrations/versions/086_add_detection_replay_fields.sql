-- Migration: Add fields for detection scope tracking
-- Version: 086
-- Description: Add detection_scope field to describe what was actually detected
--              Note: content field now stores the actual detected content (not truncated)

-- Add detection_scope field: describes what was actually detected
-- Values: 'all' (all user/assistant messages), 'last_message' (only last message due to multi-turn),
--         'user_only' (only user messages)
ALTER TABLE detection_results ADD COLUMN IF NOT EXISTS detection_scope VARCHAR(100) DEFAULT NULL;

-- Add sliding_window_count field: number of sliding windows used (NULL if no sliding window)
ALTER TABLE detection_results ADD COLUMN IF NOT EXISTS sliding_window_count INTEGER DEFAULT NULL;

-- Add matched_window_indices field: which windows matched (for debugging), e.g., [0, 2]
ALTER TABLE detection_results ADD COLUMN IF NOT EXISTS matched_window_indices JSONB DEFAULT NULL;

-- Comment on columns
COMMENT ON COLUMN detection_results.content IS 'Actual detected content (matches what was sent to model for detection)';
COMMENT ON COLUMN detection_results.detection_scope IS 'What was actually detected: all, last_message, user_only';
COMMENT ON COLUMN detection_results.sliding_window_count IS 'Number of sliding windows used for detection (NULL if no sliding window)';
COMMENT ON COLUMN detection_results.matched_window_indices IS 'Indices of windows that matched (for debugging)';
