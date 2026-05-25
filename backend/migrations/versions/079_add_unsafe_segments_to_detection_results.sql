-- Migration: Add unsafe_segments column to detection_results table
-- Description: Stores identified unsafe text segments from second-pass detection
-- Format: JSON array of {text, start, end, categories}

ALTER TABLE detection_results
ADD COLUMN IF NOT EXISTS unsafe_segments JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN detection_results.unsafe_segments IS 'Unsafe content segments identified by second-pass detection. JSON array: [{"text": "...", "start": 0, "end": 10, "categories": ["S2"]}]';
