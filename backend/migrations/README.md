# Database Migrations

This directory contains database migration scripts for OpenGuardrails.

## Automatic Migration on Startup

**Database migrations run automatically on every admin service startup!**

### All Deployment Methods Supported

Migrations run automatically regardless of how you start the services:

1. **Docker Compose**: Migrations run via [entrypoint.sh](../entrypoint.sh:1-35) before uvicorn starts
2. **Systemd Services**: Migrations run via [start_admin_service.py](../start_admin_service.py:11-34) on service startup
3. **Manual Scripts**: Migrations run via [start_all_services.sh](../start_all_services.sh:16-21) before services start
4. **Deployment Scripts**: Migrations run in deployment scripts (e.g., `xiangxin_conf/deploy/deploy_be.sh`)

**No manual intervention needed!** This ensures:
- ✅ Smooth first-time deployment
- ✅ Automatic schema updates on upgrades
- ✅ No missed migrations when pulling new code
- ✅ Safe concurrent startups (uses PostgreSQL advisory locks)

### How It Works

1. **Entrypoint Script**: [backend/entrypoint.sh](../entrypoint.sh:1-35) runs **once per container** at startup
   - Runs BEFORE uvicorn starts (container-level, not worker-level)
   - Even with multiple uvicorn workers (e.g., ADMIN_UVICORN_WORKERS=2), migrations run only once
   - Workers are forked AFTER migrations complete

2. **Migration Lock**: Uses PostgreSQL advisory locks to prevent concurrent migrations
   - `pg_try_advisory_lock()` ensures only one process can run migrations
   - If lock is held, other processes skip gracefully

3. **Admin-Only Execution**: Only the admin service runs migrations (detection/proxy services skip)
   - Prevents race conditions between multiple services
   - Single source of truth for migration execution

4. **Safe Failure Mode**: If migrations fail, the service will not start
   - Container exits with error
   - Clear error messages in logs
   - Database remains in consistent state

### Migration Tracking

All migrations are tracked in the `schema_migrations` table:

```sql
SELECT version, description, executed_at, success
FROM schema_migrations
ORDER BY version;
```

## Migration Scripts

### 001_add_ban_policy_tables.sql
Initial ban policy tables creation. Creates:
- `ban_policies` - Ban policy configuration table
- `user_ban_records` - User ban records table
- `user_risk_triggers` - User risk trigger history table

### 002_fix_ban_policy_risk_level.sql
Fixes the risk_level field to use English values instead of Chinese values.

**Issues Fixed:**
1. Ban Policy Configuration displays Chinese "高风险" instead of "High Risk" in English locale
2. Dropdown selection fails with `check_risk_level` constraint violation error

**Changes:**
- Updates existing data: `高风险` → `high_risk`, `中风险` → `medium_risk`, `低风险` → `low_risk`
- Updates constraint to accept English values: `('high_risk', 'medium_risk', 'low_risk')`
- Changes default value from `'高风险'` to `'high_risk'`

## Manual Migration (Advanced)

If you need to run migrations manually (e.g., for debugging):

### Option 1: Using the migration runner script

```bash
# From inside the admin service container
docker exec -it openguardrails-admin python3 migrations/run_migrations.py

# Dry run (show pending migrations without executing)
docker exec -it openguardrails-admin python3 migrations/run_migrations.py --dry-run
```

### Option 2: Running a specific SQL migration directly

```bash
# From the project root directory
cat backend/migrations/versions/002_fix_ban_policy_risk_level.sql | \
  docker exec -i openguardrails-postgres psql -U openguardrails -d openguardrails
```

### Verifying migrations:

```bash
# Check migration history
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "SELECT * FROM schema_migrations ORDER BY version;"

# Check specific table constraints
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "\d+ ban_policies" | grep -A 5 "Check constraints"

# Check the data
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "SELECT DISTINCT risk_level, COUNT(*) FROM ban_policies GROUP BY risk_level;"
```

## Creating New Migrations

### 1. Create SQL migration file

```bash
cd backend/migrations
./create_migration.sh add_new_feature
```

This creates `versions/XXX_add_new_feature.sql` (where XXX is auto-incremented).

### 2. Write your migration SQL

Edit the generated file with your schema changes:

```sql
-- versions/003_add_new_feature.sql
ALTER TABLE some_table ADD COLUMN new_field VARCHAR(100);
CREATE INDEX idx_new_field ON some_table(new_field);
```

### 3. Test the migration

```bash
# Test in development
docker compose restart admin-service

# Check logs to verify migration ran successfully
docker logs openguardrails-admin | grep -i migration
```

### 4. Commit the migration

```bash
git add backend/migrations/versions/003_add_new_feature.sql
git commit -m "Add migration for new feature"
```

## Migration Best Practices

1. **Idempotent Operations**: Use `IF EXISTS` / `IF NOT EXISTS` when possible
2. **Small Changes**: Keep migrations focused on a single logical change
3. **Data Safety**: Always backup before running migrations in production
4. **Testing**: Test migrations on a copy of production data first
5. **Rollback Plan**: Document how to undo the migration if needed

## Troubleshooting

### Migration failed to run

```bash
# Check migration logs
docker logs openguardrails-admin | grep -i migration

# Check migration status
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "SELECT * FROM schema_migrations WHERE success = false;"
```

### Reset migrations (DEVELOPMENT ONLY)

```bash
# WARNING: This will delete all data!
docker compose down -v
docker compose up -d
```

### Manually mark migration as executed (if re-running)

```bash
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "INSERT INTO schema_migrations (version, description, filename) VALUES (3, 'description', '003_file.sql');"
```

## Migration History

| Version | Date | Description |
|---------|------|-------------|
| 001 | 2025-10-08 | Initial ban policy tables |
| 002 | 2025-10-29 | Fix risk_level to use English values |
