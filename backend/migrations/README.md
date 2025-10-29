# Database Migrations

This directory contains all database migration files for OpenGuardrails.

## Directory Structure

```
migrations/
├── README.md           # This file
├── run_migrations.py   # Migration runner script (for SQL migrations)
├── create_migration.sh # Helper script to create new migrations
├── versions/           # SQL migration files (versioned, auto-run)
│   ├── 001_*.sql
│   ├── 002_*.sql
│   └── ...
├── 008_*.py           # Python migration files (manual execution)
├── 009_*.py
├── 010_*.py
├── 011_*.py
└── .migration_history  # Migration execution history (auto-generated)
```

## Migration Types

OpenGuardrails uses **two types of migrations**:

### 1. SQL Migrations (Automatic)
- Located in `versions/` subdirectory
- File format: `{version}_{description}.sql`
- **Automatically run** on application startup via [run_migrations.py](run_migrations.py)
- Tracked in `schema_migrations` table
- Best for: Simple DDL changes (CREATE TABLE, ALTER TABLE, etc.)

### 2. Python Migrations (Manual)
- Located directly in `migrations/` directory
- File format: `{version}_{description}.py`
- **Must be run manually** via `python migrations/008_xxx.py`
- Include complex data transformations and multi-step logic
- Best for: Data migrations, complex schema changes, backfilling data

## Migration File Naming Convention

### For SQL Migrations:
```
{version}_{description}.sql
```

Examples:
- `001_initial_schema.sql`
- `002_add_ban_policy_tables.sql`
- `003_add_tenant_kb_disable_table.sql`

### For Python Migrations:
```
{version}_{description}.py
```

Examples:
- `008_add_billing_system.py`
- `009_fix_risk_level_column_length.py`
- `010_multilingual_response_templates.py`

## Creating a New SQL Migration

1. Create a new SQL file in `versions/` with the next sequential version number
2. Write your SQL DDL statements (CREATE TABLE, ALTER TABLE, etc.)
3. Add comments to describe what the migration does
4. Test the migration locally before committing

Example SQL migration file:
```sql
-- Migration: Add user preferences table
-- Version: 005
-- Date: 2025-01-21

CREATE TABLE IF NOT EXISTS user_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    preference_key VARCHAR(100) NOT NULL,
    preference_value TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT user_preferences_unique UNIQUE (tenant_id, preference_key)
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_tenant_id ON user_preferences(tenant_id);
```

## Creating a New Python Migration

1. Create a new Python file in `migrations/` with the next sequential version number
2. Follow the template structure with `upgrade()` and `downgrade()` functions
3. Add proper path setup to import backend modules
4. Include detailed comments and logging
5. Test the migration locally before committing

Example Python migration file:
```python
"""
Migration 010: Description of what this migration does

Issue: Describe the problem
Solution: Describe the solution
"""

import sys
import os
from pathlib import Path

# Add backend directory to Python path
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

from sqlalchemy import text
from database.connection import engine
from utils.logger import setup_logger

logger = setup_logger()

def upgrade():
    """Apply the migration"""
    with engine.connect() as conn:
        try:
            logger.info("Starting migration 010: Description")

            # Your migration logic here
            conn.execute(text("""
                ALTER TABLE your_table
                ADD COLUMN new_column VARCHAR(100)
            """))

            conn.commit()
            logger.info("Migration 010 completed successfully!")
        except Exception as e:
            conn.rollback()
            logger.error(f"Migration 010 failed: {e}")
            raise

def downgrade():
    """Revert the migration"""
    with engine.connect() as conn:
        try:
            logger.info("Starting downgrade of migration 010")

            # Your rollback logic here
            conn.execute(text("""
                ALTER TABLE your_table
                DROP COLUMN new_column
            """))

            conn.commit()
            logger.info("Migration 010 downgrade completed!")
        except Exception as e:
            conn.rollback()
            logger.error(f"Migration 010 downgrade failed: {e}")
            raise

if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "downgrade":
        downgrade()
    else:
        upgrade()
```

## Running Migrations

### SQL Migrations (Automatic)
SQL migrations are **automatically run** when the application starts up (if not already executed). They are also tracked in the `schema_migrations` table.

To manually run SQL migrations:
```bash
cd backend
python3 migrations/run_migrations.py

# Dry run (show pending migrations without executing):
python3 migrations/run_migrations.py --dry-run
```

### Python Migrations (Manual)
Python migrations must be **run manually** by executing them directly:

```bash
cd backend

# Run a specific migration
python migrations/010_multilingual_response_templates.py

# Run downgrade (rollback)
python migrations/010_multilingual_response_templates.py downgrade
```

## Migration History

### For SQL Migrations:
- Tracked in the `schema_migrations` table in PostgreSQL
- Each migration version is recorded with execution timestamp
- Failed migrations are also recorded with error messages
- Use [run_migrations.py](run_migrations.py) to view migration status

### For Python Migrations:
- **Not automatically tracked** - you must manually track execution
- Best practice: Note in git commits or deployment logs when executed
- Consider creating a separate tracking table if needed

## Best Practices

### General:
1. **Idempotent**: Always use `IF NOT EXISTS` / `IF EXISTS` to make migrations safe to re-run
2. **Incremental**: Keep each migration focused on a single change or feature
3. **Reversible**: Always provide a `downgrade()` function for Python migrations
4. **Test**: Test migrations on a copy of production data before deploying
5. **Version Control**: Always commit migration files to git
6. **Sequential Numbering**: Ensure migrations are numbered sequentially, never skip numbers

### SQL Migrations:
- Best for simple DDL changes (CREATE TABLE, ALTER TABLE, ADD INDEX)
- Automatically run on startup - no manual intervention needed
- Tracked in `schema_migrations` table
- Use for most schema changes

### Python Migrations:
- Best for complex data transformations and multi-step operations
- **Must be run manually** before deploying application code that depends on them
- Include detailed logging to track progress
- Use when SQL alone is not sufficient (e.g., data backfills, JSON transformations)

## Choosing Between SQL and Python Migrations

**Use SQL migrations when:**
- Simple DDL changes (CREATE, ALTER, DROP)
- Adding/removing columns
- Creating indexes
- Adding constraints
- No complex data transformation needed

**Use Python migrations when:**
- Complex data transformations (e.g., converting TEXT to JSON)
- Multi-step operations with conditional logic
- Backfilling data based on complex rules
- Need to use application business logic during migration
- Need fine-grained error handling and rollback

## Notes

- SQL migrations are run in order based on version number
- Each SQL migration is only run once (tracked in `schema_migrations`)
- Failed SQL migrations will halt the migration process and log errors
- Python migrations must be manually executed and tracked
- Always test migrations in development environment first
