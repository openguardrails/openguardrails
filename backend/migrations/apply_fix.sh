#!/bin/bash

# Automated fix script for proxy_model_configs foreign key issue
# Usage: ./apply_fix.sh

set -e  # Exit on any error

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}Proxy Model Configs FK Fix Script${NC}"
echo -e "${YELLOW}========================================${NC}"
echo ""

# Check for required environment variables
if [ -z "$DB_USER" ] || [ -z "$DB_NAME" ]; then
    echo -e "${YELLOW}Please set environment variables:${NC}"
    echo "  export DB_USER=your_db_user"
    echo "  export DB_NAME=your_db_name"
    echo "  export PGPASSWORD=your_db_password (optional)"
    echo ""
    echo "Or pass them directly:"
    echo "  DB_USER=postgres DB_NAME=openguardrails ./apply_fix.sh"
    exit 1
fi

# Set default values if not provided
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

echo -e "${GREEN}Database Configuration:${NC}"
echo "  Host: $DB_HOST"
echo "  Port: $DB_PORT"
echo "  User: $DB_USER"
echo "  Database: $DB_NAME"
echo ""

# Check if psql is available
if ! command -v psql &> /dev/null; then
    echo -e "${RED}Error: psql command not found. Please install PostgreSQL client.${NC}"
    exit 1
fi

# Test database connection
echo -e "${YELLOW}Step 1: Testing database connection...${NC}"
if ! psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" > /dev/null 2>&1; then
    echo -e "${RED}Error: Cannot connect to database. Please check your credentials.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Database connection successful${NC}"
echo ""

# Run diagnostic script
echo -e "${YELLOW}Step 2: Running diagnostic check...${NC}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "$SCRIPT_DIR/../diagnose_fk_issues.sql"
echo ""

# Ask for confirmation
read -p "Do you want to proceed with the fix? (yes/no): " -r
echo
if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    echo -e "${YELLOW}Operation cancelled by user.${NC}"
    exit 0
fi

# Create backup (optional but recommended)
echo -e "${YELLOW}Step 3: Creating backup (recommended)...${NC}"
read -p "Do you want to create a backup before applying the fix? (yes/no): " -r
echo
if [[ $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
    BACKUP_FILE="backup_before_fk_fix_$(date +%Y%m%d_%H%M%S).sql"
    echo "Creating backup: $BACKUP_FILE"
    pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" > "$BACKUP_FILE"
    echo -e "${GREEN}✓ Backup created: $BACKUP_FILE${NC}"
else
    echo -e "${YELLOW}⚠ Skipping backup (not recommended)${NC}"
fi
echo ""

# Apply the fix
echo -e "${YELLOW}Step 4: Applying the fix...${NC}"
if psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -f "$SCRIPT_DIR/versions/006_fix_proxy_model_configs_fk.sql"; then
    echo -e "${GREEN}✓ Fix applied successfully${NC}"
else
    echo -e "${RED}✗ Error applying fix. Please check the error messages above.${NC}"
    exit 1
fi
echo ""

# Verify the fix
echo -e "${YELLOW}Step 5: Verifying the fix...${NC}"
VERIFY_SQL="
SELECT 
    tc.constraint_name,
    ccu.table_name AS foreign_table_name,
    ccu.column_name AS foreign_column_name
FROM 
    information_schema.table_constraints AS tc 
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
WHERE 
    tc.table_name = 'proxy_model_configs' 
    AND tc.constraint_type = 'FOREIGN KEY';
"

psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "$VERIFY_SQL"
echo ""

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Fix completed successfully!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "Next steps:"
echo "1. Test creating a proxy model config with the affected user account"
echo "2. Monitor application logs for any related errors"
echo "3. If you created a backup, you can safely delete it after confirming everything works"
echo ""

