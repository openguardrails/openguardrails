#!/bin/bash

# Migration file creator script
# Usage: ./create_migration.sh "description_of_migration"

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSIONS_DIR="$SCRIPT_DIR/versions"

if [ $# -eq 0 ]; then
    echo "Error: Migration description is required"
    echo "Usage: $0 \"description_of_migration\""
    echo "Example: $0 \"add_user_preferences_table\""
    exit 1
fi

DESCRIPTION="$1"

# Get next version number
LATEST_VERSION=$(ls -1 "$VERSIONS_DIR" | grep -E "^[0-9]+_" | sed 's/_.*//' | sort -n | tail -1)

if [ -z "$LATEST_VERSION" ]; then
    NEXT_VERSION="001"
else
    NEXT_VERSION=$(printf "%03d" $((10#$LATEST_VERSION + 1)))
fi

# Create migration filename
FILENAME="${NEXT_VERSION}_${DESCRIPTION}.sql"
FILEPATH="$VERSIONS_DIR/$FILENAME"

# Check if file already exists
if [ -f "$FILEPATH" ]; then
    echo "Error: Migration file already exists: $FILENAME"
    exit 1
fi

# Create migration template
cat > "$FILEPATH" << EOF
-- Migration: ${DESCRIPTION}
-- Version: ${NEXT_VERSION}
-- Date: $(date +%Y-%m-%d)
-- Author: TODO

-- Description:
-- TODO: Add description of what this migration does

-- Example SQL:
-- CREATE TABLE IF NOT EXISTS example_table (
--     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--     name VARCHAR(255) NOT NULL,
--     created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
-- );

-- CREATE INDEX IF NOT EXISTS idx_example_table_name ON example_table(name);

-- Add your SQL statements below:

EOF

echo "✓ Created migration file: $FILENAME"
echo "  Path: $FILEPATH"
echo ""
echo "Next steps:"
echo "  1. Edit the migration file and add your SQL statements"
echo "  2. Test the migration locally"
echo "  3. Commit the migration file to git"
echo ""
echo "To run migrations:"
echo "  python3 migrations/run_migrations.py"
