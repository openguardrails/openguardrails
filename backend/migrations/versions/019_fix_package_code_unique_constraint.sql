-- Fix package_code unique constraint to allow multiple versions of same package
-- Archive packages are excluded from the unique constraint

-- First, drop the old unique constraint on package_code
ALTER TABLE scanner_packages DROP CONSTRAINT IF EXISTS scanner_packages_package_code_key;

-- Create a unique partial index that ensures package_code uniqueness for active, non-archived packages
CREATE UNIQUE INDEX idx_scanner_packages_active_code_unique
ON scanner_packages(package_code)
WHERE (is_active = true AND archived = false);

-- Create index for better performance on all package lookups
CREATE INDEX idx_scanner_packages_active_filter
ON scanner_packages(is_active, archived);

-- Create index for archived packages lookup
CREATE INDEX idx_scanner_packages_archived
ON scanner_packages(package_code, archived_at)
WHERE archived = true;