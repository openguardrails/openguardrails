#!/bin/bash

# PostgreSQL database setup script

set -e

echo "OpenGuardrails Platform - PostgreSQL database setup"
echo "==========================================="

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "Error: Docker is not installed, please install Docker first"
    exit 1
fi

# Stop existing containers (if any)
echo "Stopping existing PostgreSQL containers..."
docker stop openguardrails-postgres 2>/dev/null || true
docker rm openguardrails-postgres 2>/dev/null || true

# Create data directories
echo "Creating data directories..."
sudo mkdir -p ~/openguardrails-data/db
sudo mkdir -p ~/openguardrails-data/logs
sudo mkdir -p ~/openguardrails-data/logs/detection
sudo chown -R $USER:$USER ~/openguardrails-data/

# Start PostgreSQL container
echo "Starting PostgreSQL container..."
docker run -d \
  --name openguardrails-postgres \
  -e POSTGRES_USER=openguardrails \
  -e POSTGRES_PASSWORD='openguardrails@20250808' \
  -p 54321:5432 \
  -v ~/openguardrails-data/db:/var/lib/postgresql/data \
  postgres:latest

# Wait for PostgreSQL to start
echo "Waiting for PostgreSQL to start..."
sleep 10

# Check connection
echo "Checking PostgreSQL connection..."
for i in {1..30}; do
    if docker exec openguardrails-postgres pg_isready -U openguardrails; then
        echo "PostgreSQL started successfully!"
        break
    fi
    
    if [ $i -eq 30 ]; then
        echo "Error: PostgreSQL startup timed out"
        exit 1
    fi
    
    echo "Waiting for PostgreSQL to start... ($i/30)"
    sleep 2
done

# Create database
echo "Creating application database..."
docker exec openguardrails-postgres psql -U openguardrails -c "CREATE DATABASE openguardrails;" || echo "Database may already exist"

echo ""
echo "PostgreSQL database setup completed!"
echo "Database information:"
echo "  Host: localhost"
echo "  Port: 54321"
echo "  Username: openguardrails"
echo "  Password: openguardrails@20250808"
echo "  Database: openguardrails"
echo ""
echo "Connection string: postgresql://openguardrails:openguardrails%4020250808@localhost:54321/openguardrails"
echo ""
echo "You can use the following command to connect to the database:"
echo "  docker exec -it openguardrails-postgres psql -U openguardrails -d openguardrails"