# Multi-stage build for OpenGuardrails Platform
# This Dockerfile combines frontend (React + Nginx) and backend (Python FastAPI) services

# ============================================
# Stage 1: Build Frontend
# ============================================
FROM node:18-alpine AS frontend-builder

WORKDIR /app/frontend

# Copy frontend package files
COPY frontend/package*.json ./

# Install frontend dependencies
RUN npm install

# Copy frontend source code
COPY frontend/ .

# Build parameters: allow setting Vite base prefix
ARG VITE_BASE=/platform/
ENV VITE_BASE=${VITE_BASE}

# Build frontend
RUN VITE_BASE=${VITE_BASE} npm run build

# ============================================
# Stage 2: Build Backend Base
# ============================================
FROM python:3.11-slim AS backend-base

WORKDIR /app

# Install system dependencies (including nginx, postgresql-client, curl)
RUN apt-get update && apt-get install -y \
    gcc \
    curl \
    nginx \
    postgresql-client \
    supervisor \
    && rm -rf /var/lib/apt/lists/*

# Copy backend dependency files
COPY backend/requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# ============================================
# Stage 3: Final Platform Image
# ============================================
FROM backend-base AS platform

WORKDIR /app

# Copy backend source code
COPY backend/ .

# Copy frontend build artifacts from frontend-builder
COPY --from=frontend-builder /app/frontend/dist /usr/share/nginx/html/platform

# Copy landing page
COPY landing /usr/share/nginx/html/landing

# Copy nginx configuration
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf

# Copy and set entrypoint script permissions
COPY entrypoint.sh /app/entrypoint.sh
COPY backend/supervisor-entrypoint.sh /app/supervisor-entrypoint.sh
RUN chmod +x /app/entrypoint.sh /app/supervisor-entrypoint.sh

# Create data, log, and media directories
RUN mkdir -p /app/data /app/logs /mnt/data/openguardrails-data/media /mnt/data/openguardrails-data/logs

# Create supervisor configuration directory
RUN mkdir -p /etc/supervisor/conf.d

# Copy supervisor configuration
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

# Expose ports for all services
# 80: Frontend (Nginx)
# 5000: Admin Service
# 5001: Detection Service
# 5002: Proxy Service
EXPOSE 80 5000 5001 5002

# Use entrypoint for startup initialization
ENTRYPOINT ["/app/entrypoint.sh"]

# Start supervisor to manage all processes
CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
