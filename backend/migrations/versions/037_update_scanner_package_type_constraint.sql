-- Migration: update_scanner_package_type_constraint
-- Version: 037
-- Date: 2025-12-18
-- Author: TODO

-- Description:
-- Update scanner package constraint to support 'basic' instead of 'builtin'

-- Update existing records with 'builtin' to 'basic'
UPDATE scanner_packages
SET package_type = 'basic'
WHERE package_type = 'builtin';

-- Drop the old constraint
ALTER TABLE scanner_packages DROP CONSTRAINT IF EXISTS chk_package_type;

-- Add the new constraint with updated values
ALTER TABLE scanner_packages
ADD CONSTRAINT chk_package_type
CHECK (package_type IN ('basic', 'purchasable', 'custom'));

-- Note: 'basic' = basic/free packages (formerly 'builtin')
--       'purchasable' = premium/paid packages
--       'custom' = custom user-defined packages (S100+)

