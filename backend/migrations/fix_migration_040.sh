#!/bin/bash
# Fix migration 040 failure caused by SQLAlchemy-created table schema mismatch
# This script resets the migration state so it can be re-run with the fixed migration file

set -e

# Configuration - adjust these if needed
CONTAINER_NAME="${POSTGRES_CONTAINER:-openguardrails-postgres}"
DB_USER="${POSTGRES_USER:-openguardrails}"
DB_NAME="${POSTGRES_DB:-openguardrails}"
DB_PASSWORD="${POSTGRES_PASSWORD:-your_password}"

echo "============================================================"
echo "Fix Migration 040 Script"
echo "============================================================"
echo "Container: $CONTAINER_NAME"
echo "Database: $DB_NAME"
echo "User: $DB_USER"
echo ""

# Check if container exists and is running
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
    echo "Error: Container '$CONTAINER_NAME' is not running."
    echo "Available containers:"
    docker ps --format '{{.Names}}'
    exit 1
fi

echo "Step 1: Dropping failed migration tables..."
docker exec -e PGPASSWORD="$DB_PASSWORD" "$CONTAINER_NAME" psql -U "$DB_USER" -d "$DB_NAME" -c "
DROP TABLE IF EXISTS application_data_leakage_policies_backup;
DROP TABLE IF EXISTS tenant_data_leakage_policies CASCADE;
"

echo "Step 2: Removing migration 040 record..."
docker exec -e PGPASSWORD="$DB_PASSWORD" "$CONTAINER_NAME" psql -U "$DB_USER" -d "$DB_NAME" -c "
DELETE FROM schema_migrations WHERE version = 40;
"

echo "Step 3: Verifying cleanup..."
PENDING=$(docker exec -e PGPASSWORD="$DB_PASSWORD" "$CONTAINER_NAME" psql -U "$DB_USER" -d "$DB_NAME" -t -c "
SELECT COUNT(*) FROM schema_migrations WHERE version = 40;
")

if [ "$(echo $PENDING | tr -d ' ')" = "0" ]; then
    echo "✓ Migration 040 record removed successfully"
else
    echo "✗ Warning: Migration record may not have been removed"
fi

TABLE_EXISTS=$(docker exec -e PGPASSWORD="$DB_PASSWORD" "$CONTAINER_NAME" psql -U "$DB_USER" -d "$DB_NAME" -t -c "
SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'tenant_data_leakage_policies';
")

if [ "$(echo $TABLE_EXISTS | tr -d ' ')" = "0" ]; then
    echo "✓ tenant_data_leakage_policies table removed successfully"
else
    echo "✗ Warning: Table may still exist"
fi

echo ""
echo "============================================================"
echo "Cleanup complete!"
echo "============================================================"
echo ""
echo "Next steps:"
echo "1. Make sure the updated migration file is deployed"
echo "2. Restart the admin service to re-run migrations:"
echo "   docker restart openguardrails-admin"
echo "   # or"
echo "   docker compose restart admin"
echo ""
echo "3. Check migration logs:"
echo "   docker logs openguardrails-admin 2>&1 | grep -i migration"
echo ""
