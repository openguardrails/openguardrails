# Database Migration Guide

## Overview

OpenGuardrails now uses an automated database migration system to manage schema changes.

## Migration System Features

✅ **Automatic Execution**: Automatically runs pending migrations when the application starts
✅ **Version Tracking**: Tracks executed migrations via the `schema_migrations` table
✅ **Idempotency**: All migrations use `IF NOT EXISTS` / `IF EXISTS` to ensure idempotency
✅ **Sequential Execution**: Migrations are executed in version number order
✅ **Error Handling**: Stops execution and logs errors when a migration fails
✅ **Independent Operation**: Can run migrations independently without starting the application

## Directory Structure

```
backend/
├── migrations/
│   ├── README.md                 # Migration system documentation
│   ├── create_migration.sh       # Script to create a new migration
│   ├── run_migrations.py         # Migration runner
│   └── versions/                 # Migration SQL files
│       ├── 001_add_ban_policy_tables.sql
│       ├── 002_add_tenant_kb_disable_table.sql
│       └── ...
```

## Creating a New Migration

### Method 1: Using the Script (Recommended)

```bash
cd backend/migrations
./create_migration.sh "add_user_preferences_table"
```

This automatically creates a new migration file with a version number and template.

### Method 2: Manual Creation

1. Create a new file in the `backend/migrations/versions/` directory
2. File naming format: `{version}_{description}.sql`

   * Example: `003_add_user_preferences.sql`
3. Write your SQL statements

### Example Migration File

```sql
-- Migration: Add user preferences table
-- Version: 003
-- Date: 2025-01-21
-- Author: Your Name

-- Description:
-- Adds a table to store user-specific preferences and settings

CREATE TABLE IF NOT EXISTS user_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    preference_key VARCHAR(100) NOT NULL,
    preference_value TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT user_preferences_unique UNIQUE (tenant_id, preference_key)
);

CREATE INDEX IF NOT EXISTS idx_user_preferences_tenant_id
ON user_preferences(tenant_id);

COMMENT ON TABLE user_preferences IS 'Stores user-specific preferences and settings';
COMMENT ON COLUMN user_preferences.preference_key IS 'Preference key identifier';
COMMENT ON COLUMN user_preferences.preference_value IS 'Preference value (JSON or text)';
```

## Migration Best Practices

### 1. Idempotency

**Always** use `IF NOT EXISTS` / `IF EXISTS`:

```sql
-- ✓ Correct
CREATE TABLE IF NOT EXISTS my_table (...);
CREATE INDEX IF NOT EXISTS idx_name ON my_table(column);
ALTER TABLE my_table ADD COLUMN IF NOT EXISTS new_column VARCHAR(100);

-- ✗ Incorrect
CREATE TABLE my_table (...);  -- Will fail on repeated runs
```

### 2. Incremental Changes

Each migration should do only one thing:

```sql
-- ✓ Correct - Focused on a single feature
-- Migration: Add email notification preferences
CREATE TABLE IF NOT EXISTS email_preferences (...);

-- ✗ Incorrect - Mixing unrelated changes
CREATE TABLE IF NOT EXISTS email_preferences (...);
CREATE TABLE IF NOT EXISTS user_avatars (...);
ALTER TABLE tenants ADD COLUMN phone_number VARCHAR(20);
```

### 3. Backward Compatibility

Ensure migrations don’t break existing functionality:

```sql
-- ✓ Correct - Adding optional column
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'UTC';

-- ⚠️ Note - Adding NOT NULL columns requires a default value
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';

-- ✗ Dangerous - Dropping columns may break existing code
-- ALTER TABLE tenants DROP COLUMN IF EXISTS old_field;  -- Evaluate carefully
```

### 4. Add Comments

Add descriptive comments for tables and columns:

```sql
COMMENT ON TABLE my_table IS 'Stores user preferences for the application';
COMMENT ON COLUMN my_table.status IS 'Current status: active, inactive, or pending';
```

### 5. Index Optimization

Add indexes for frequently queried columns:

```sql
-- Single-column index
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Composite index (order matters)
CREATE INDEX IF NOT EXISTS idx_logs_tenant_date ON logs(tenant_id, created_at DESC);

-- Partial index (only index rows matching condition)
CREATE INDEX IF NOT EXISTS idx_active_users ON users(email) WHERE is_active = true;
```

## Running Migrations

### Automatic Execution (On Startup)

Migrations run automatically when the application starts (in `admin-service` only):

```bash
docker-compose up
# or
python3 start_admin_service.py
```

You’ll see log output like this:

```
Running database migrations...
Found 2 pending migration(s):
  - 001: add_ban_policy_tables
  - 002: add_tenant_kb_disable_table
Executing migration 001: add_ban_policy_tables
✓ Migration 001 completed successfully
Executing migration 002: add_tenant_kb_disable_table
✓ Migration 002 completed successfully
Database migrations completed: 2 migration(s) executed
```

### Manual Execution

```bash
cd backend
python3 migrations/run_migrations.py
```

### Preview Pending Migrations (Dry Run)

```bash
cd backend
python3 migrations/run_migrations.py --dry-run
```

## Migration Tracking Table

The system uses the `schema_migrations` table to track executed migrations:

```sql
SELECT * FROM schema_migrations ORDER BY version;
```

| version | description                 | filename                            | executed_at         | success | error_message |
| ------- | --------------------------- | ----------------------------------- | ------------------- | ------- | ------------- |
| 1       | add_ban_policy_tables       | 001_add_ban_policy_tables.sql       | 2025-01-21 10:00:00 | true    | null          |
| 2       | add_tenant_kb_disable_table | 002_add_tenant_kb_disable_table.sql | 2025-01-21 10:00:01 | true    | null          |

## Common Issues

### Q: What if a migration fails?

1. Check the error logs
2. Fix the issue in the migration SQL file
3. Delete the failed record from `schema_migrations`:

   ```sql
   DELETE FROM schema_migrations WHERE version = X;
   ```
4. Re-run the migration

### Q: How to roll back a migration?

Automatic rollback is not supported yet. To roll back manually:

1. Write rollback SQL manually (include it in migration comments if possible)
2. Execute the rollback SQL manually
3. Delete the record from `schema_migrations`

### Q: Can I modify an executed migration?

**Do not modify executed migrations.** If you need to make changes:

1. Create a new migration for the modification
2. This ensures historical consistency

### Q: Development vs. Production Environments

* **Development**: You may use `RESET_DATABASE_ON_STARTUP=true` to reset the DB
* **Production**: **Must** set `RESET_DATABASE_ON_STARTUP=false` and rely only on migrations

## Environment Variables Configuration

In `docker-compose.yml` or `.env`:

```yaml
environment:
  # Development: resets database on each startup (all data lost)
  - RESET_DATABASE_ON_STARTUP=true

  # Production: preserves data, only runs new migrations
  - RESET_DATABASE_ON_STARTUP=false
```

## Migrating to the New System

Steps for migrating existing projects:

1. Ensure all manual SQL scripts have already been run
2. The new migration system will automatically create the `schema_migrations` table
3. On first run, it will execute all migrations in the `versions/` directory
4. Previously executed migrations will run again, but `IF NOT EXISTS` ensures no effect

## Example Workflow

### Adding a New Feature Requiring DB Changes

1. **Create the migration**:

   ```bash
   cd backend/migrations
   ./create_migration.sh "add_notification_settings"
   ```

2. **Edit the migration file**:

   ```sql
   -- Migration: Add notification settings
   -- Version: 003

   CREATE TABLE IF NOT EXISTS notification_settings (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
       email_enabled BOOLEAN DEFAULT true,
       sms_enabled BOOLEAN DEFAULT false,
       created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
   );
   ```

3. **Test locally**:

   ```bash
   python3 migrations/run_migrations.py --dry-run  # Preview
   python3 migrations/run_migrations.py             # Execute
   ```

4. **Update code**: Add Python logic to use the new table

5. **Commit to Git**:

   ```bash
   git add backend/migrations/versions/003_add_notification_settings.sql
   git add backend/database/models.py  # if models were updated
   git commit -m "Add notification settings table"
   ```

6. **Deploy**: The application will automatically run the new migration on startup

## Summary

✅ Migration system is now fully automated
✅ Automatically executes all pending migrations on first startup
✅ Version-controlled and sequential execution
✅ Idempotent and safe to re-run
✅ Tracks execution history for traceability

**Remember**: Always use `IF NOT EXISTS` / `IF EXISTS` in your migrations to ensure idempotency!
