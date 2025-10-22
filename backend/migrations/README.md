# Database Migrations

This directory contains all database migration files for OpenGuardrails.

## Directory Structure

```
migrations/
├── README.md           # This file
├── run_migrations.py   # Migration runner script
├── versions/           # Migration SQL files (versioned)
│   ├── 001_*.sql
│   ├── 002_*.sql
│   └── ...
└── .migration_history  # Migration execution history (auto-generated)
```

## Migration File Naming Convention

Migration files should follow this naming pattern:
```
{version}_{description}.sql
```

Examples:
- `001_initial_schema.sql`
- `002_add_ban_policy_tables.sql`
- `003_add_tenant_kb_disable_table.sql`

## Creating a New Migration

1. Create a new SQL file in `versions/` with the next sequential version number
2. Write your SQL DDL statements (CREATE TABLE, ALTER TABLE, etc.)
3. Add comments to describe what the migration does
4. Test the migration locally before committing

Example migration file:
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

## Running Migrations

Migrations are automatically run when the application starts up (if not already executed).

To manually run migrations:
```bash
cd backend
python3 migrations/run_migrations.py
```

## Migration History

The `.migration_history` file tracks which migrations have been executed. This file is automatically managed and should not be edited manually.

## Best Practices

1. **Idempotent**: Always use `IF NOT EXISTS` / `IF EXISTS` to make migrations idempotent
2. **Incremental**: Keep each migration focused on a single change or feature
3. **Reversible**: Consider adding rollback SQL in comments
4. **Test**: Test migrations on a copy of production data before deploying
5. **Version Control**: Always commit migration files to git
6. **Order**: Ensure migrations are numbered sequentially and never skip numbers

## Notes

- Migrations are run in order based on version number
- Each migration is only run once
- Failed migrations will halt the migration process and log errors
- The migration table `schema_migrations` tracks execution status
