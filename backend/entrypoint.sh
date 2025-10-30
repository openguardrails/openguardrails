#!/bin/bash
set -e

echo "=================================================="
echo "OpenGuardrails Service Starting..."
echo "Service: $SERVICE_NAME"
echo "PID: $$"
echo "=================================================="

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL to be ready..."
until pg_isready -h postgres -p 5432 -U openguardrails; do
  echo "PostgreSQL is unavailable - sleeping"
  sleep 2
done

echo "PostgreSQL is ready!"

# Only run migrations from admin service to avoid race conditions
# NOTE: This runs ONCE per container, BEFORE uvicorn starts workers
# Even if uvicorn spawns multiple workers (e.g., ADMIN_UVICORN_WORKERS=2),
# migrations run only once here, before the workers are forked.
if [ "$SERVICE_NAME" = "admin" ]; then
  echo "Running database migrations (admin service)..."
  echo "NOTE: Migrations run ONCE before uvicorn workers start"
  python3 migrations/run_migrations.py || {
    echo "Warning: Migration check failed, continuing anyway..."
  }
  echo "Migrations completed. Now starting uvicorn..."
fi

# Execute the main command (replaces this process with uvicorn)
echo "Starting $SERVICE_NAME service (PID will be replaced)..."
exec "$@"
