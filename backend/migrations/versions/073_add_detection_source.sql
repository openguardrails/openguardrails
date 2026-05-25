-- Migration: Add source column to detection_results
-- Description: Track where each detection result originated from (guardrail_api, proxy, gateway, direct_model, content_scan)

-- Add source column
ALTER TABLE detection_results ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT NULL;

-- Create index for filtering by source
CREATE INDEX IF NOT EXISTS idx_detection_results_source ON detection_results(source);
