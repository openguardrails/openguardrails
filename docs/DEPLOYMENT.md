# Deployment Guide

## Docker Compose Deployment (Recommended)

Using Docker Compose is the simplest deployment method — all services will be automatically networked and configured.

**OpenGuardrails 2.0** adopts a three-service architecture:

* **Admin Service** (Port 5000): Handles management platform APIs
* **Detection Service** (Port 5001): High-concurrency guardrail detection API
* **Proxy Service** (Port 5002): Secure gateway reverse proxy 🆕

```bash
# Start all services
docker compose up -d

# View service status
docker compose ps

# View logs
docker compose logs -f

# View specific service logs
docker compose logs -f admin-service      # Admin Service
docker compose logs -f detection-service  # Detection Service
docker compose logs -f proxy-service      # Proxy Service
```

## Manual Local Deployment

If you prefer to start each service manually (for development or debugging), please pay attention to the following configuration details:

### 1. Environment Configuration

Copy and modify the environment configuration file:

```bash
cp backend/.env.local.example backend/.env
```

Key configuration items:

* `DETECTION_HOST=localhost`  # Use localhost in local environment
* `DATABASE_URL=postgresql://...`  # Database connection URL
* Modify other settings as needed

### 2. Startup Order

1. Start the PostgreSQL database
2. Start the detection service (port 5001)
3. Start the admin service (port 5000)
4. Start the proxy service (port 5002) 🆕
5. Start the frontend (port 3000)

### 3. Service Connection Configuration

The system automatically determines connection settings based on the `DETECTION_HOST` environment variable:

* **Docker Environment**: `DETECTION_HOST=detection-service` (use Docker service name)
* **Local Environment**: `DETECTION_HOST=localhost` (use local host)

## Environment Variable Reference

| Variable         | Docker Default      | Local Default | Description                |
| ---------------- | ------------------- | ------------- | -------------------------- |
| `DETECTION_HOST` | `detection-service` | `localhost`   | Detection service hostname |
| `DETECTION_PORT` | `5001`              | `5001`        | Detection service port     |
| `ADMIN_PORT`     | `5000`              | `5000`        | Admin service port         |
| `PROXY_PORT`     | `5002`              | `5002`        | Proxy service port 🆕      |

## Troubleshooting

### Connection Failure

If you see the error message **“Guardrail API call failed: All connection attempts failed”**, try the following:

1. Check whether `DETECTION_HOST` is correctly configured
2. Ensure that `detection-service` is running and accessible
3. Verify that your API key is valid

### Switching Environments

Switch from Docker to local development:

```bash
export DETECTION_HOST=localhost
```

Switch from local to Docker:

```bash
export DETECTION_HOST=detection-service
```
