# Database Migration Flow Visualization

## High-Level Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     docker compose up -d                         │
└────────────────────────────┬────────────────────────────────────┘
                             │
                ┌────────────┴────────────┐
                │                         │
                ▼                         ▼
    ┌───────────────────┐     ┌──────────────────────┐
    │   PostgreSQL      │     │  Other Services      │
    │   Container       │     │  (Detection, Proxy,  │
    │                   │     │   Frontend)          │
    │   Healthcheck:    │     │                      │
    │   pg_isready      │     │  Wait for:           │
    │                   │     │  - PostgreSQL        │
    └─────────┬─────────┘     │  - Admin Service     │
              │               └──────────────────────┘
              │ Ready!
              │
              ▼
    ┌──────────────────────────────────────────────────────────┐
    │          Admin Service Container                         │
    │                                                          │
    │  ┌────────────────────────────────────────────────────┐ │
    │  │  ENTRYPOINT: /app/entrypoint.sh                    │ │
    │  │  (Runs ONCE per container startup)                 │ │
    │  │                                                    │ │
    │  │  Step 1: Wait for PostgreSQL (pg_isready)         │ │
    │  │          ↓                                         │ │
    │  │  Step 2: Check SERVICE_NAME                       │ │
    │  │          if [ "$SERVICE_NAME" = "admin" ]          │ │
    │  │          ↓                                         │ │
    │  │  Step 3: Run migrations/run_migrations.py         │ │
    │  │          (Protected by PostgreSQL advisory lock)   │ │
    │  │          ↓                                         │ │
    │  │  Step 4: exec python3 start_admin_service.py      │ │
    │  │          (Replaces shell process with Python)     │ │
    │  └────────────────────────────────────────────────────┘ │
    │                                                          │
    │  ┌────────────────────────────────────────────────────┐ │
    │  │  Uvicorn Master Process                            │ │
    │  │  (After migrations are complete)                   │ │
    │  │                                                    │ │
    │  │  Forks worker processes:                          │ │
    │  │  ┌──────────────────┐  ┌──────────────────┐      │ │
    │  │  │  Worker 1        │  │  Worker 2        │      │ │
    │  │  │  Handle requests │  │  Handle requests │      │ │
    │  │  └──────────────────┘  └──────────────────┘      │ │
    │  └────────────────────────────────────────────────────┘ │
    └──────────────────────────────────────────────────────────┘
```

## Detailed Migration Execution Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  Admin Container Starts                                          │
└────────────────┬────────────────────────────────────────────────┘
                 │
                 ▼
        ┌────────────────────┐
        │  entrypoint.sh     │
        │  PID: 1            │
        └─────────┬──────────┘
                  │
                  ▼
        ┌─────────────────────────────────┐
        │ Wait for PostgreSQL (pg_isready)│
        │ Loop until ready...              │
        └─────────┬───────────────────────┘
                  │
                  ▼
        ┌─────────────────────────────────┐
        │ Check: SERVICE_NAME == "admin"? │
        └─────────┬───────────────────────┘
                  │ YES
                  ▼
        ┌──────────────────────────────────────────────────────┐
        │  python3 migrations/run_migrations.py                 │
        │                                                       │
        │  ┌────────────────────────────────────────────────┐  │
        │  │ 1. Connect to PostgreSQL                       │  │
        │  │    with AUTOCOMMIT mode                        │  │
        │  └────────────┬───────────────────────────────────┘  │
        │               │                                       │
        │               ▼                                       │
        │  ┌────────────────────────────────────────────────┐  │
        │  │ 2. Try to acquire advisory lock               │  │
        │  │    pg_try_advisory_lock(0x4D49475241544F)      │  │
        │  └────────────┬───────────────────────────────────┘  │
        │               │                                       │
        │        ┌──────┴──────┐                                │
        │        │             │                                │
        │     Lock         Lock already                         │
        │   acquired       held by                              │
        │        │         another                               │
        │        │         process                               │
        │        │             │                                │
        │        │             ▼                                │
        │        │    ┌──────────────────┐                      │
        │        │    │ Log: "Another    │                      │
        │        │    │  process is      │                      │
        │        │    │  running         │                      │
        │        │    │  migrations,     │                      │
        │        │    │  skipping..."    │                      │
        │        │    │ Return (0, 0)    │                      │
        │        │    └──────────────────┘                      │
        │        │                                               │
        │        ▼                                               │
        │  ┌────────────────────────────────────────────────┐  │
        │  │ 3. Create schema_migrations table if needed   │  │
        │  │    CREATE TABLE IF NOT EXISTS...               │  │
        │  └────────────┬───────────────────────────────────┘  │
        │               │                                       │
        │               ▼                                       │
        │  ┌────────────────────────────────────────────────┐  │
        │  │ 4. Query executed migrations                  │  │
        │  │    SELECT version FROM schema_migrations       │  │
        │  │    WHERE success = true                        │  │
        │  └────────────┬───────────────────────────────────┘  │
        │               │                                       │
        │               ▼                                       │
        │  ┌────────────────────────────────────────────────┐  │
        │  │ 5. Find pending migrations                    │  │
        │  │    (files in versions/ not in DB)              │  │
        │  └────────────┬───────────────────────────────────┘  │
        │               │                                       │
        │        ┌──────┴──────┐                                │
        │        │             │                                │
        │     Pending        No pending                         │
        │   migrations      migrations                          │
        │        │             │                                │
        │        │             ▼                                │
        │        │    ┌──────────────────┐                      │
        │        │    │ Log: "All        │                      │
        │        │    │  migrations      │                      │
        │        │    │  up to date"     │                      │
        │        │    │ Return (0, 0)    │                      │
        │        │    └──────────────────┘                      │
        │        │                                               │
        │        ▼                                               │
        │  ┌────────────────────────────────────────────────┐  │
        │  │ 6. Execute pending migrations in order        │  │
        │  │    For each migration:                         │  │
        │  │    - Read SQL file                             │  │
        │  │    - Execute SQL                               │  │
        │  │    - Record in schema_migrations               │  │
        │  │    - Commit transaction                        │  │
        │  │    - If error: rollback & record failure       │  │
        │  └────────────┬───────────────────────────────────┘  │
        │               │                                       │
        │               ▼                                       │
        │  ┌────────────────────────────────────────────────┐  │
        │  │ 7. Release advisory lock                      │  │
        │  │    pg_advisory_unlock()                        │  │
        │  └────────────┬───────────────────────────────────┘  │
        │               │                                       │
        │               ▼                                       │
        │  ┌────────────────────────────────────────────────┐  │
        │  │ 8. Return (executed_count, failed_count)       │  │
        │  └────────────────────────────────────────────────┘  │
        │                                                       │
        └───────────────────────┬───────────────────────────────┘
                                │
                                ▼
                ┌───────────────────────────────┐
                │ Check migration result        │
                └────────┬──────────────────────┘
                         │
                  ┌──────┴──────┐
                  │             │
               Success      Any failures
                  │             │
                  │             ▼
                  │    ┌──────────────────┐
                  │    │ Exit with error  │
                  │    │ (Container stops)│
                  │    └──────────────────┘
                  │
                  ▼
        ┌─────────────────────────────────┐
        │ exec python3 start_admin_service.py │
        │ (Replaces shell process)         │
        └─────────┬───────────────────────┘
                  │
                  ▼
        ┌─────────────────────────────────┐
        │  Uvicorn Master Process         │
        │  PID: 1 (replaced from shell)   │
        └─────────┬───────────────────────┘
                  │
                  ▼
        ┌─────────────────────────────────┐
        │  Fork Worker Processes          │
        │                                 │
        │  Worker 1 (PID: X)              │
        │  Worker 2 (PID: Y)              │
        │                                 │
        │  Both workers handle requests   │
        │  (Migrations already complete!) │
        └─────────────────────────────────┘
```

## Timeline: Container Startup with 2 Workers

```
Time  │  Process                               │  PID  │  Notes
──────┼────────────────────────────────────────┼───────┼──────────────────
t=0s  │  Docker starts container               │   -   │  Container created
t=0s  │  entrypoint.sh starts                  │   1   │  ENTRYPOINT runs
t=1s  │  Waiting for PostgreSQL...             │   1   │  pg_isready loop
t=3s  │  PostgreSQL ready!                     │   1   │  Healthcheck passed
t=3s  │  Starting migration runner             │   1   │  Fork Python process
t=3s  │  Migration runner starts               │  123  │  Child process
t=4s  │  Acquire advisory lock                 │  123  │  Lock: 0x4D49...
t=4s  │  Query schema_migrations table         │  123  │  Check executed
t=4s  │  Found 2 pending migrations            │  123  │  Need to run 001, 002
t=5s  │  Executing migration 001...            │  123  │  Run SQL
t=6s  │  Migration 001 complete ✓              │  123  │  Recorded in DB
t=6s  │  Executing migration 002...            │  123  │  Run SQL
t=7s  │  Migration 002 complete ✓              │  123  │  Recorded in DB
t=7s  │  Release advisory lock                 │  123  │  Unlock
t=7s  │  Migration runner exits                │   -   │  Process 123 ends
t=7s  │  Migrations completed!                 │   1   │  Back to shell
t=8s  │  exec start_admin_service.py           │   1   │  Replace process
t=8s  │  Uvicorn master starts                 │   1   │  Same PID (exec)
t=9s  │  Uvicorn forks worker 1                │  200  │  Fork from master
t=9s  │  Uvicorn forks worker 2                │  201  │  Fork from master
t=10s │  Admin service ready!                  │ 1,200,│  All running
      │                                        │  201  │
──────┴────────────────────────────────────────┴───────┴──────────────────

Key Observations:
- Migrations run at t=3s to t=7s (before uvicorn starts)
- Workers fork at t=9s (after migrations complete)
- Only ONE migration execution, even with 2 workers
- Workers never see migration code (happens before their creation)
```

## Multiple Services Starting Concurrently

```
Time  │  Admin Service        │  Detection Service   │  Proxy Service
──────┼──────────────────────┼──────────────────────┼────────────────────
t=0s  │  Container starts     │  Container starts    │  Container starts
t=0s  │  entrypoint.sh        │  entrypoint.sh       │  entrypoint.sh
t=1s  │  Wait PostgreSQL...   │  Wait PostgreSQL...  │  Wait PostgreSQL...
t=3s  │  PostgreSQL ready!    │  PostgreSQL ready!   │  PostgreSQL ready!
t=3s  │  SERVICE_NAME=admin   │  SERVICE_NAME=detect │  SERVICE_NAME=proxy
t=3s  │  ✓ Run migrations     │  ✗ Skip migrations   │  ✗ Skip migrations
t=4s  │  Acquire lock ✓       │  -                   │  -
t=7s  │  Migrations done      │  -                   │  -
t=7s  │  Release lock         │  -                   │  -
t=8s  │  Start uvicorn        │  Start uvicorn       │  Start uvicorn
t=9s  │  Fork 2 workers       │  Fork 32 workers     │  Fork 24 workers
t=10s │  Ready! (2 workers)   │  Ready! (32 workers) │  Ready! (24 workers)
──────┴──────────────────────┴──────────────────────┴────────────────────

Total Migration Executions: 1 (only admin service)
Total Workers: 2 + 32 + 24 = 58 workers (none run migrations!)
```

## What If Admin Service Restarts While Running?

```
Scenario: Admin service restarts while detection/proxy are running

Time  │  Admin Service (Restart)      │  PostgreSQL Lock State
──────┼───────────────────────────────┼────────────────────────────
t=0s  │  Container restarts           │  Lock: free
t=1s  │  entrypoint.sh starts         │  Lock: free
t=3s  │  PostgreSQL ready             │  Lock: free
t=3s  │  Start migration runner       │  Lock: free
t=4s  │  Try acquire lock...          │  Lock: acquired by admin
t=4s  │  Query schema_migrations      │  Lock: held by admin
t=4s  │  All migrations up to date!   │  Lock: held by admin
t=4s  │  Return (0, 0)                │  Lock: held by admin
t=4s  │  Release lock                 │  Lock: free
t=5s  │  Start uvicorn                │  Lock: free
t=6s  │  Fork 2 workers               │  Lock: free
t=7s  │  Ready!                       │  Lock: free
──────┴───────────────────────────────┴────────────────────────────

Result: No duplicate migrations, even on restart!
```

## Summary

### Key Takeaways

1. **Container-Level Execution**
   - `entrypoint.sh` runs once per container
   - Not once per worker
   - Migrations complete before workers fork

2. **Service Isolation**
   - Only admin service runs migrations
   - Detection service skips (SERVICE_NAME != admin)
   - Proxy service skips (SERVICE_NAME != admin)

3. **Database-Level Protection**
   - PostgreSQL advisory locks prevent concurrent execution
   - Even if multiple containers try simultaneously
   - Only one can acquire lock and run migrations

4. **Safe with Multiple Workers**
   - 2 admin workers: ✓ Safe
   - 32 detection workers: ✓ Safe
   - 24 proxy workers: ✓ Safe
   - **Migrations run exactly once!**

5. **Idempotent Design**
   - Safe to run multiple times
   - Checks `schema_migrations` table
   - Skips already-executed migrations

### Testing Command

```bash
# Verify migrations run only once
docker compose down -v
docker compose up -d
docker logs openguardrails-admin | grep -c "Running database migrations"
# Expected output: 1 (not 2, despite 2 workers)

# Check migration records
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "SELECT version, COUNT(*) FROM schema_migrations GROUP BY version;"
# Each version should have COUNT = 1
```

---

**Conclusion**: The automatic migration system is **safe with multiple workers** because migrations run at the **container startup level**, before workers are forked, with additional protection from PostgreSQL advisory locks.
