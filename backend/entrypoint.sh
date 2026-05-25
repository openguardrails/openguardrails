#!/bin/bash
set -e

echo "=================================================="
echo "OpenGuardrails Service Starting..."
echo "Service: $SERVICE_NAME"
echo "PID: $$"
echo "Command: $@"
echo "=================================================="

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL to be ready..."
until pg_isready -h postgres -p 5432 -U openguardrails; do
  echo "PostgreSQL is unavailable - sleeping"
  sleep 2
done

echo "PostgreSQL is ready!"

# Check if running supervisord directly (Docker compose mode)
if [[ "$*" == *"supervisord"* ]]; then
  echo "=== OpenGuardrails Platform Container Starting ==="
  echo "Current time: $(date)"
  echo "Starting supervisord mode - database will be initialized by admin-service..."
  # In supervisord mode, run initialization immediately before starting supervisor
  echo "Initializing database and running migrations (Docker compose mode)..."

  # Step 1: Create table structure only (minimal=True to avoid querying tables before migration)
  echo "Step 1: Creating database tables..."
  python3 -c "
import asyncio
from database.connection import init_db
async def main():
    try:
        await init_db(minimal=True)
        print('Database table creation completed successfully')
    except Exception as e:
        print(f'Database table creation failed: {e}')
        raise
asyncio.run(main())
" || {
      echo "Warning: Database table creation failed, continuing anyway..."
  }

  # Step 2: Run migrations (add new columns, fix schema, etc.)
  echo "Step 2: Running migrations..."
  python3 migrations/run_migrations.py || {
    echo "Warning: Migration check failed, continuing anyway..."
  }

  # Step 3: Initialize data (super admin, default configs) - now safe because migrations have run
  echo "Step 3: Initializing data..."
  python3 -c "
import asyncio
from database.connection import init_db
async def main():
    try:
        await init_db(minimal=False)
        print('Database initialization completed successfully')
    except Exception as e:
        print(f'Database initialization failed: {e}')
        raise
asyncio.run(main())
" || {
      echo "Warning: Database initialization failed, continuing anyway..."
  }

  echo "Database initialization and migrations completed. Now starting supervisord..."
else
  # Only run database initialization and migrations from admin service to avoid race conditions
  # NOTE: This runs ONCE per container, BEFORE uvicorn starts workers
  # Even if uvicorn spawns multiple workers (e.g., ADMIN_UVICORN_WORKERS=2),
  # migrations run only once here, before the workers are forked.
  if [ "$SERVICE_NAME" = "admin" ]; then
  echo "Initializing database and running migrations (admin service)..."
  echo "NOTE: Database init and migrations run ONCE before uvicorn workers start"

  # Step 1: Create table structure only (minimal=True to avoid querying tables before migration)
  echo "Step 1: Creating database tables..."
  python3 -c "
import asyncio
from database.connection import init_db
async def main():
    try:
        await init_db(minimal=True)
        print('Database table creation completed successfully')
    except Exception as e:
        print(f'Database table creation failed: {e}')
        raise
asyncio.run(main())
" || {
    echo "Warning: Database table creation failed, continuing anyway..."
  }

  # Step 2: Run migrations (add new columns, fix schema, etc.)
  echo "Step 2: Running migrations..."
  python3 migrations/run_migrations.py || {
    echo "Warning: Migration check failed, continuing anyway..."
  }

  # Step 3: Initialize data (super admin, default configs) - now safe because migrations have run
  echo "Step 3: Initializing data..."
  python3 -c "
import asyncio
from database.connection import init_db
async def main():
    try:
        await init_db(minimal=False)
        print('Database initialization completed successfully')
    except Exception as e:
        print(f'Database initialization failed: {e}')
        raise
asyncio.run(main())
" || {
    echo "Warning: Database initialization failed, continuing anyway..."
  }

  echo "Database initialization and migrations completed. Now starting uvicorn..."
fi
fi

# Execute the main command
if [[ "$*" == *"supervisord"* ]]; then
  echo "Starting supervisord..."
else
  echo "Starting $SERVICE_NAME service (PID will be replaced)..."
fi
exec "$@"
