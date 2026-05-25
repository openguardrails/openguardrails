-- Migration: add_price_column_to_scanner_packages
-- Version: 020
-- Date: 2025-11-09
-- Author: Auto-generated

-- Description:
-- Add price column to scanner_packages table to store original numeric price
-- This allows for dynamic currency symbol display based on user's language preference

-- Add your SQL statements below:

ALTER TABLE scanner_packages ADD COLUMN IF NOT EXISTS price FLOAT;

-- Add comment to explain the column purpose
COMMENT ON COLUMN scanner_packages.price IS 'Original numeric price for dynamic currency display';

