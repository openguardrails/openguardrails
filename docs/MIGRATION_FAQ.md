# Database Migration FAQ

## Common Questions About Automatic Migrations

### Q1: We have 2 admin workers (ADMIN_UVICORN_WORKERS=2). Won't migrations run twice?

**A: No, migrations run only once, even with multiple workers.**

**Explanation**:

The `entrypoint.sh` script runs at the **container level**, not at the **worker level**:

```
Container Startup Flow:
======================
1. Docker starts container
   ↓
2. ENTRYPOINT ["/app/entrypoint.sh"] runs ONCE (container-level)
   ↓
3. entrypoint.sh executes:
   - Wait for PostgreSQL
   - Run migrations (ONCE)
   - exec python3 start_admin_service.py
   ↓
4. Uvicorn starts (replaces the shell process)
   ↓
5. Uvicorn master process forks 2 worker processes
   (Migrations are already complete at this point)
   ↓
6. Worker 1 handles requests
   Worker 2 handles requests
```

**Key Points**:
- ✅ `entrypoint.sh` runs **once per container**, not once per worker
- ✅ Migrations complete **before** uvicorn starts
- ✅ Workers are forked **after** migrations finish
- ✅ Even if there were concurrent attempts, PostgreSQL advisory locks would prevent duplicate execution

### Q2: What about the detection service (32 workers) and proxy service (24 workers)?

**A: They don't run migrations at all.**

Only the **admin service** runs migrations (controlled by `SERVICE_NAME=admin` environment variable):

```bash
# In entrypoint.sh
if [ "$SERVICE_NAME" = "admin" ]; then
  # Only runs for admin service
  python3 migrations/run_migrations.py
fi
```

- Detection service: `SERVICE_NAME=detection` → skips migrations
- Proxy service: `SERVICE_NAME=proxy` → skips migrations
- Admin service: `SERVICE_NAME=admin` → runs migrations once

### Q3: What if multiple services start at the same time?

**A: PostgreSQL advisory locks prevent race conditions.**

Even if:
- Admin service starts (runs migrations)
- Detection service starts (skips migrations - different SERVICE_NAME)
- Proxy service starts (skips migrations - different SERVICE_NAME)
- Admin service restarts while another is running

The migration runner uses a **PostgreSQL advisory lock**:

```python
# In run_migrations.py
migration_lock_key = 0x4D49_4752_4154_494F  # "MIGRATIO" in hex

with admin_engine.connect() as lock_conn:
    result = lock_conn.execute(
        text("SELECT pg_try_advisory_lock(:k)"),
        {"k": migration_lock_key}
    )
    lock_acquired = result.scalar()

    if not lock_acquired:
        logger.info("Another process is running migrations, skipping...")
        return 0, 0  # Skip gracefully

    # Only one process gets here
    run_migrations()

    # Release lock when done
```

**Protection levels**:
1. ✅ **Service-level**: Only admin service runs migrations (`SERVICE_NAME=admin`)
2. ✅ **Container-level**: Migrations run once per container, not per worker
3. ✅ **Database-level**: Advisory locks prevent concurrent execution

### Q4: How can I verify migrations ran only once?

Check the migration logs:

```bash
# View migration execution logs
docker logs openguardrails-admin | grep -i migration

# Expected output (ONLY ONCE):
# Running database migrations (admin service)...
# NOTE: Migrations run ONCE before uvicorn workers start
# Successfully executed X migration(s)
# Migrations completed. Now starting uvicorn...
```

Check the migration history in the database:

```bash
# Each migration should have only ONE record
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "SELECT version, description, executed_at FROM schema_migrations ORDER BY version;"

# Example output:
#  version |         description          |         executed_at
# ---------+------------------------------+----------------------------
#        1 | add ban policy tables        | 2025-10-29 10:15:23.456789
#        2 | fix ban policy risk level    | 2025-10-29 10:15:23.567890
```

Each version should appear **exactly once**, regardless of the number of workers.

### Q5: What happens if I restart the admin service?

**A: Migrations are idempotent - safe to run multiple times.**

When you restart:
```bash
docker restart openguardrails-admin
```

The flow is:
1. Container restarts
2. `entrypoint.sh` runs again
3. Migration runner checks `schema_migrations` table
4. Sees migrations already executed
5. Logs: "✓ All migrations are up to date"
6. Starts uvicorn normally

**No duplicate execution.**

### Q6: Can I see the migration lock in action?

Yes! Try this experiment:

```bash
# Terminal 1: Manually run migrations with a delay
docker exec -it openguardrails-admin bash -c "
  echo 'Process 1 starting...';
  python3 migrations/run_migrations.py &
  sleep 1;
  echo 'Process 2 starting...';
  python3 migrations/run_migrations.py;
  wait
"

# You'll see:
# Process 1: Running migrations...
# Process 2: Another process is running migrations, skipping...
```

The advisory lock ensures only one process executes migrations.

### Q7: What if migrations fail?

The service **will not start**:

```bash
# Check service status
docker ps --filter "name=openguardrails-admin"

# If migration failed, container may be restarting or exited

# Check logs for error
docker logs openguardrails-admin | grep -A 10 "Migration.*failed"

# Fix the migration file, then restart
docker restart openguardrails-admin
```

This is a **safety feature** - better to fail early than run with an incorrect database schema.

### Q8: Does RESET_DATABASE_ON_STARTUP affect migrations?

**No, and you should set it to `false`.**

In [docker-compose.yml](../docker-compose.yml):
```yaml
- RESET_DATABASE_ON_STARTUP=false  # Recommended
```

- `RESET_DATABASE_ON_STARTUP=true` is a **legacy feature** for development
- It resets the **entire database** on every startup (data loss!)
- Migrations handle schema evolution properly without data loss
- **Production deployments must use `false`**

### Q9: How do I add a new migration?

```bash
# 1. Create migration file
cd backend/migrations
./create_migration.sh add_new_column

# 2. Edit the generated file
# versions/003_add_new_column.sql

# 3. Test from clean state
docker compose down -v
docker compose up -d

# 4. Verify migration ran
docker logs openguardrails-admin | grep -i migration

# 5. Check database
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "SELECT * FROM schema_migrations WHERE version = 3;"
```

The new migration will run automatically on the next deployment!

### Q10: Can I run migrations manually?

Yes, for debugging purposes:

```bash
# Dry run (show pending migrations without executing)
docker exec -it openguardrails-admin python3 migrations/run_migrations.py --dry-run

# Execute manually
docker exec -it openguardrails-admin python3 migrations/run_migrations.py

# Run specific SQL migration
cat backend/migrations/versions/003_migration.sql | \
  docker exec -i openguardrails-postgres psql -U openguardrails -d openguardrails
```

But in normal operation, migrations run automatically - no manual intervention needed!

---

## Summary

**The automatic migration system is safe with multiple workers because**:

1. ✅ Migrations run at **container startup** (once per container)
2. ✅ Migrations run **before** uvicorn starts workers
3. ✅ Workers are forked **after** migrations complete
4. ✅ Only **admin service** runs migrations (other services skip)
5. ✅ **PostgreSQL advisory locks** prevent concurrent execution
6. ✅ Migrations are **idempotent** (safe to run multiple times)

**You can safely have**:
- 2 admin workers
- 32 detection workers
- 24 proxy workers

**Migrations will still run exactly once on deployment!**

---

## Related Documentation

- [backend/migrations/README.md](../backend/migrations/README.md) - Migration system overview
- [docs/AUTO_MIGRATION_TEST.md](AUTO_MIGRATION_TEST.md) - Testing procedures
- [backend/entrypoint.sh](../backend/entrypoint.sh) - Startup script
- [backend/migrations/run_migrations.py](../backend/migrations/run_migrations.py) - Migration runner
