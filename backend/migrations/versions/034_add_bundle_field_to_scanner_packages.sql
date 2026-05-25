-- Migration: add_bundle_field_to_scanner_packages
-- Version: 034
-- Date: 2025-12-12
-- Author: System

-- Description:
-- Add bundle field to scanner_packages table for grouping premium packages

-- Add bundle column (IF NOT EXISTS for idempotency)
ALTER TABLE scanner_packages ADD COLUMN IF NOT EXISTS bundle VARCHAR(100);

-- Add index for sorting by bundle
CREATE INDEX IF NOT EXISTS idx_scanner_packages_bundle ON scanner_packages(bundle);

-- Add comment
COMMENT ON COLUMN scanner_packages.bundle IS 'Bundle name for grouping premium packages (e.g., Enterprise, Security, Compliance)';

