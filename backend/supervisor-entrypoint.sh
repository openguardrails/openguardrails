#!/bin/bash
set -e

echo "=================================================="
echo "OpenGuardrails Service Starting via Supervisor..."
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

# Only run database initialization and migrations from admin service to avoid race conditions
if [ "$SERVICE_NAME" = "admin" ]; then
  echo "Initializing database and running migrations (admin service)..."

  # First initialize database schema (creates all tables)
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

  # Then run migrations
  python3 migrations/run_migrations.py || {
      echo "Warning: Migration check failed, continuing anyway..."
  }
  echo "Database initialization and migrations completed. Now starting service..."
fi

# Execute the main command (replaces this process with the actual service)
echo "Starting $SERVICE_NAME service..."
exec "$@"