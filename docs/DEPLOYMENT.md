# Deployment Guide

> Complete guide for deploying OpenGuardrails in production and development environments

## Table of Contents

- [Overview](#overview)
- [Prerequisites](#prerequisites)
- [Quick Deployment (Recommended)](#quick-deployment-recommended)
- [Architecture Overview](#architecture-overview)
- [Step-by-Step Deployment](#step-by-step-deployment)
- [Production Security Checklist](#production-security-checklist)
- [Troubleshooting](#troubleshooting)
- [Alternative Deployment Options](#alternative-deployment-options)

---

## Overview

OpenGuardrails uses a **separation of concerns** architecture where AI models and the platform run independently. This design provides:

- ✅ Flexibility to deploy models on different servers (GPU requirements)
- ✅ Freedom to use any compatible model API (OpenAI-compatible)
- ✅ Simplified platform deployment (no GPU dependency)

---

## Prerequisites

### Required
- **Docker** and **Docker Compose** installed ([installation guide](https://docs.docker.com/engine/install/ubuntu/))
- **Hugging Face account** for model access token
- **8GB+ RAM** for platform services
- **Open ports**: 3000, 5000, 5001, 5002, 54321

### For Model Deployment (Optional)
- **GPU server** with CUDA drivers (Ubuntu recommended)
- **NVIDIA GPU** with 8GB+ VRAM (for text model)
- **16GB+ RAM** recommended

---

## Quick Deployment (Recommended)

### Option 1: Pre-built Images (Production)

**Best for**: Production deployment, end-users, no source code needed

```bash
# 1. Download production docker-compose file
curl -O https://raw.githubusercontent.com/openguardrails/openguardrails/main/docker-compose.prod.yml

# 2. Create .env file with your configuration
cat > .env << EOF
# Model API endpoints (replace with your GPU server IPs)
# ⚠️ IMPORTANT: Do NOT use localhost or 127.0.0.1 here!
# Use the actual IP address of your GPU server that is accessible from the Docker containers.
GUARDRAILS_MODEL_API_URL=http://YOUR_GPU_SERVER_IP:58002/v1
GUARDRAILS_MODEL_API_KEY=EMPTY
GUARDRAILS_MODEL_NAME=OpenGuardrails-Text

EMBEDDING_API_BASE_URL=http://YOUR_GPU_SERVER_IP:58004/v1
EMBEDDING_API_KEY=EMPTY
EMBEDDING_MODEL_NAME=bge-m3

# Optional: Vision-Language model (if you have it deployed)
# ⚠️ IMPORTANT: Do NOT use localhost or 127.0.0.1 here!
# GUARDRAILS_VL_MODEL_API_URL=http://YOUR_GPU_SERVER_IP:58003/v1
# GUARDRAILS_VL_MODEL_API_KEY=EMPTY
# GUARDRAILS_VL_MODEL_NAME=OpenGuardrails-VL

# Security (CHANGE THESE IN PRODUCTION!)
SUPER_ADMIN_USERNAME=admin@yourdomain.com
SUPER_ADMIN_PASSWORD=CHANGE-THIS-PASSWORD-IN-PRODUCTION
JWT_SECRET_KEY=your-secret-key-change-in-production
POSTGRES_PASSWORD=your_password

# Specify pre-built image from Docker Hub (or your private registry)
PLATFORM_IMAGE=openguardrails/openguardrails-platform:latest
# For private registry: PLATFORM_IMAGE=your-registry.com/openguardrails-platform:version
EOF

# 3. Launch the platform (uses pre-built image, no build required)
docker compose -f docker-compose.prod.yml up -d
```

### Option 2: Build from Source (Development)

**Best for**: Developers, customization

```bash
# 1. Clone the repository
git clone https://github.com/openguardrails/openguardrails
cd openguardrails

# 2. Create .env file with your model endpoints
cat > .env << EOF
# Model API endpoints (replace with your GPU server IPs)
# ⚠️ IMPORTANT: Do NOT use localhost or 127.0.0.1 here!
# Use the actual IP address of your GPU server that is accessible from the Docker containers.
GUARDRAILS_MODEL_API_URL=http://YOUR_GPU_SERVER_IP:58002/v1
GUARDRAILS_MODEL_API_KEY=EMPTY
GUARDRAILS_MODEL_NAME=OpenGuardrails-Text

EMBEDDING_API_BASE_URL=http://YOUR_GPU_SERVER_IP:58004/v1
EMBEDDING_API_KEY=EMPTY
EMBEDDING_MODEL_NAME=bge-m3

# Security (CHANGE THESE IN PRODUCTION!)
SUPER_ADMIN_USERNAME=admin@yourdomain.com
SUPER_ADMIN_PASSWORD=CHANGE-THIS-PASSWORD-IN-PRODUCTION
JWT_SECRET_KEY=your-secret-key-change-in-production
POSTGRES_PASSWORD=your_password
EOF

# 3. Build and launch
docker compose up -d --build
```

---

## Architecture Overview

OpenGuardrails consists of these components:

```
┌─────────────────────────────────────────────────────────────┐
│                      GPU Server (Optional)                  │
│  ┌──────────────────┐        ┌──────────────────┐          │
│  │  Text Model      │        │  Embedding Model │          │
│  │  Port 58002      │        │  Port 58004      │          │
│  └──────────────────┘        └──────────────────┘          │
└─────────────────────────────────────────────────────────────┘
                           ▲
                           │ API Calls
                           │
┌─────────────────────────────────────────────────────────────┐
│                    Application Server                       │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │           OpenGuardrails Platform Container           │ │
│  │                                                        │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐           │ │
│  │  │  Admin   │  │Detection │  │  Proxy   │           │ │
│  │  │  :5000   │  │  :5001   │  │  :5002   │           │ │
│  │  └──────────┘  └──────────┘  └──────────┘           │ │
│  │                                                        │ │
│  │  ┌──────────────────────────────────────┐            │ │
│  │  │         Frontend :3000               │            │ │
│  │  └──────────────────────────────────────┘            │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │           PostgreSQL :54321                           │ │
│  └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## Step-by-Step Deployment

### Step 1: Deploy AI Models (Optional)

**⚠️ Deploy these on a GPU server first** (or use cloud AI APIs)

#### 🧠 Text Model (OpenGuardrails-Text-2510)

```bash
# Install vLLM (if not already installed)
pip install vllm

# Set your Hugging Face token
export HF_TOKEN=your-hf-token

# Start the text model service
vllm serve openguardrails/OpenGuardrails-Text-2510 \
  --port 58002 \
  --served-model-name OpenGuardrails-Text \
  --max-model-len 8192

# Or use Docker:
docker run --gpus all -p 58002:8000 \
  -e HF_TOKEN=your-hf-token \
  vllm/vllm-openai:v0.10.1.1 \
  --model openguardrails/OpenGuardrails-Text-2510 \
  --port 8000 \
  --served-model-name OpenGuardrails-Text \
  --max-model-len 8192
```

**Verify it's running:**
```bash
# ⚠️ IMPORTANT: Use actual IP, NOT localhost/127.0.0.1
curl http://YOUR_GPU_SERVER_IP:58002/v1/models
```

#### 🔍 Embedding Model (bge-m3)

```bash
# Start the embedding model service
vllm serve BAAI/bge-m3 \
  --port 58004 \
  --served-model-name bge-m3

# Or use Docker:
docker run --gpus all -p 58004:8000 \
  -e HF_TOKEN=your-hf-token \
  vllm/vllm-openai:v0.10.1.1 \
  --model BAAI/bge-m3 \
  --port 8000 \
  --served-model-name bge-m3
```

**Verify it's running:**
```bash
# ⚠️ IMPORTANT: Use actual IP, NOT localhost/127.0.0.1
curl http://YOUR_GPU_SERVER_IP:58004/v1/models
```

### Step 2: Deploy OpenGuardrails Platform

Choose your deployment method from [Quick Deployment](#quick-deployment-recommended) above.

### Step 3: Monitor Deployment

```bash
# Watch platform startup
docker logs -f openguardrails-platform

# Expected output:
# - "Running database migrations..."
# - "Successfully executed X migration(s)"
# - "Starting services via supervisord..."

# Check all containers
docker ps

# Expected output:
# - openguardrails-postgres (healthy)
# - openguardrails-platform (healthy)
```

### Step 4: Access the Platform

👉 **Web Interface**: [http://localhost:3000/platform/](http://localhost:3000/platform/)

**Default credentials:**
- **Username**: `admin@yourdomain.com`
- **Password**: `CHANGE-THIS-PASSWORD-IN-PRODUCTION`

**API Endpoints:**
- Admin API: `http://localhost:5000`
- Detection API: `http://localhost:5001`
- Proxy API: `http://localhost:5002`

---

## Production Security Checklist

Before deploying to production, update these in your `.env` file:

```bash
# ✅ Change default credentials
SUPER_ADMIN_USERNAME=admin@your-company.com
SUPER_ADMIN_PASSWORD=YourSecurePassword123!

# ✅ Generate secure JWT secret
JWT_SECRET_KEY=$(openssl rand -hex 32)

# ✅ Secure database password
POSTGRES_PASSWORD=$(openssl rand -hex 16)

# ✅ Configure model API keys (if using commercial APIs)
GUARDRAILS_MODEL_API_KEY=sk-your-actual-api-key
EMBEDDING_API_KEY=sk-your-actual-embedding-key

# ✅ Update CORS origins for your domain
CORS_ORIGINS=https://yourdomain.com,https://app.yourdomain.com

# ✅ Configure SMTP for email notifications
SMTP_SERVER=smtp.gmail.com
SMTP_PORT=587
SMTP_USERNAME=notifications@yourdomain.com
SMTP_PASSWORD=your-smtp-password
SMTP_USE_TLS=true
SMTP_USE_SSL=false

# ✅ Enable production mode
DEBUG=false
LOG_LEVEL=INFO
```

### Additional Security Measures

1. **Firewall Configuration**
   ```bash
   # Allow only necessary ports
   ufw allow 3000/tcp  # Frontend (or use reverse proxy)
   ufw allow 5000/tcp  # Admin API
   ufw allow 5001/tcp  # Detection API
   ufw allow 5002/tcp  # Proxy API
   ```

2. **Use Reverse Proxy (Nginx/Traefik)**
   - SSL/TLS termination
   - Rate limiting
   - IP whitelisting

3. **Database Security**
   - Change default port 54321
   - Enable SSL connections
   - Regular backups

4. **API Key Rotation**
   - Rotate API keys regularly
   - Implement key expiration
   - Monitor API usage

---

## Troubleshooting

### Deployment Fails

**Check PostgreSQL:**
```bash
docker logs openguardrails-postgres
```

**Check migrations:**
```bash
docker logs openguardrails-platform | grep -i migration
```

**Check health:**
```bash
docker ps
```

**Reset and retry:**
```bash
docker compose down -v
docker system prune -f
docker compose up -d
```

### Common Issues

#### Port Conflicts
```bash
# Check which process is using a port
lsof -i :3000
lsof -i :5000
lsof -i :5001
lsof -i :5002
lsof -i :54321

# Kill the process if needed
kill -9 <PID>
```

#### PostgreSQL Not Ready
- Check healthcheck in `docker-compose.yml`
- Ensure proper database credentials
- Check disk space

#### Migration Failed
- Check SQL syntax error in migration files
- Verify database connectivity
- Check migration logs

#### Model Connection Issues
- Verify model endpoints are accessible
- Use actual IP addresses, not localhost
- Check firewall rules
- Verify model API keys

### Debug Mode

Enable debug mode for detailed logs:

```bash
# Add to .env
DEBUG=true
LOG_LEVEL=DEBUG

# Restart services
docker compose restart
```

---

## Alternative Deployment Options

### Use Cloud AI APIs

OpenGuardrails is **model-agnostic**! You can use any OpenAI-compatible API:

```bash
# Example: Using OpenAI directly
GUARDRAILS_MODEL_API_URL=https://api.openai.com/v1
GUARDRAILS_MODEL_API_KEY=sk-your-openai-key
GUARDRAILS_MODEL_NAME=gpt-4

# Example: Using local Ollama
GUARDRAILS_MODEL_API_URL=http://localhost:11434/v1
GUARDRAILS_MODEL_API_KEY=ollama
GUARDRAILS_MODEL_NAME=llama2

# Example: Using Anthropic Claude via proxy
GUARDRAILS_MODEL_API_URL=https://api.anthropic.com/v1
GUARDRAILS_MODEL_API_KEY=sk-ant-your-key
GUARDRAILS_MODEL_NAME=claude-3-sonnet
```

### Kubernetes Deployment

See [k8s-manifests/](../k8s-manifests/) for Kubernetes deployment manifests.

### Docker Swarm

See [docker-stack.yml](../docker-stack.yml) for Docker Swarm configuration.

### Manual Deployment (Development)

For local development without Docker:

```bash
# 1. Start PostgreSQL
# Install PostgreSQL and create database

# 2. Install Python dependencies
cd backend
pip install -r requirements.txt

# 3. Start services
python start_admin_service.py &
python start_detection_service.py &
python start_proxy_service.py &

# 4. Start frontend
cd ../frontend
npm install
npm run dev
```

---

## Environment Variables Reference

### Database
- `DATABASE_URL` - PostgreSQL connection URL
- `POSTGRES_PASSWORD` - PostgreSQL password

### Authentication
- `JWT_SECRET_KEY` - Secret key for JWT tokens
- `SUPER_ADMIN_USERNAME` - Default admin username
- `SUPER_ADMIN_PASSWORD` - Default admin password

### Models
- `GUARDRAILS_MODEL_API_URL` - Text model endpoint
- `GUARDRAILS_MODEL_API_KEY` - Text model API key
- `GUARDRAILS_MODEL_NAME` - Text model name
- `EMBEDDING_API_BASE_URL` - Embedding model endpoint
- `EMBEDDING_API_KEY` - Embedding model API key
- `EMBEDDING_MODEL_NAME` - Embedding model name

### Services
- `ADMIN_PORT` - Admin service port (default: 5000)
- `DETECTION_PORT` - Detection service port (default: 5001)
- `PROXY_PORT` - Proxy service port (default: 5002)
- `ADMIN_UVICORN_WORKERS` - Admin worker count (default: 2)
- `DETECTION_UVICORN_WORKERS` - Detection worker count (default: 32)
- `PROXY_UVICORN_WORKERS` - Proxy worker count (default: 24)

### Other
- `CORS_ORIGINS` - Allowed CORS origins
- `DEBUG` - Enable debug mode (true/false)
- `LOG_LEVEL` - Logging level (DEBUG/INFO/WARNING/ERROR)
- `DATA_DIR` - Data directory path

---

## What You Have Now

After successful deployment:

1. **AI Models** (on GPU server or cloud):
   - Text model service on port **58002**
   - Embedding model service on port **58004**

2. **OpenGuardrails Platform** (can run on any server):
   - PostgreSQL database - Port **54321**
   - Web interface - Port **3000**
   - Admin API - Port **5000**
   - Detection API - Port **5001**
   - Proxy API - Port **5002**

3. **Automatic Features**:
   - ✅ Database migrations run automatically
   - ✅ Admin user created on first startup
   - ✅ All services managed by Supervisor

---

## Next Steps

- 📗 [Create Custom Scanners](CUSTOM_SCANNERS.md)
- 📙 [Read API Reference](API_REFERENCE.md)
- 🔌 [Set up Integrations](INTEGRATIONS/)
- 🏢 [Enterprise PoC Guide](ENTERPRISE_POC.md)

---

**Last Updated**: 2025-01-21
**Need Help?** Contact thomas@openguardrails.com
