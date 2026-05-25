-- Migration: fix_model_direct_access_design
-- Version: 036
-- Date: 2025-12-17
-- Author: Claude

-- Description:
-- Fix model direct access design issues:
-- 1. Add is_direct_model_access field to detection_results to distinguish direct model access from guardrail calls
-- 2. Remove model_usage table (merge counting with detection_results)

-- Add is_direct_model_access field to detection_results
ALTER TABLE detection_results
ADD COLUMN IF NOT EXISTS is_direct_model_access BOOLEAN DEFAULT FALSE;

-- Create index for efficient queries on is_direct_model_access
CREATE INDEX IF NOT EXISTS idx_detection_results_is_direct_model_access
ON detection_results(is_direct_model_access);

-- Drop model_usage table (no longer needed, counts merged with detection_results)
DROP TABLE IF EXISTS model_usage;

