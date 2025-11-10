-- Add archive functionality to scanner_packages
-- Allows archiving packages instead of deleting them, removing them from user view
-- while maintaining the same package_code uniqueness constraints for active packages

-- Add archived column to scanner_packages
ALTER TABLE scanner_packages ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT FALSE;

-- Add index for efficient querying of non-archived packages
CREATE INDEX IF NOT EXISTS idx_scanner_packages_not_archived ON scanner_packages(is_active, archived);

-- Add index for package_code to enforce uniqueness for non-archived active packages
CREATE INDEX IF NOT EXISTS idx_scanner_packages_active_code ON scanner_packages(package_code, is_active, archived) WHERE is_active = TRUE AND archived = FALSE;

-- Add archive_reason column (optional)
ALTER TABLE scanner_packages ADD COLUMN IF NOT EXISTS archive_reason TEXT;

-- Add archived_at timestamp
ALTER TABLE scanner_packages ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;

-- Add archived_by admin user reference
ALTER TABLE scanner_packages ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES tenants(id);

-- Comment on the new functionality
COMMENT ON COLUMN scanner_packages.archived IS 'Indicates if package is archived (hidden from users but preserved in database)';
COMMENT ON COLUMN scanner_packages.archive_reason IS 'Reason why the package was archived';
COMMENT ON COLUMN scanner_packages.archived_at IS 'Timestamp when the package was archived';
COMMENT ON COLUMN scanner_packages.archived_by IS 'Admin user who archived the package';

-- Update the unique constraint logic for future reference:
-- UNIQUE constraint is now implicitly enforced for active, non-archived packages with the same code
-- Archived packages can have duplicate package_codes (for historical preservation)