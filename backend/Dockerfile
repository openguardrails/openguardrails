FROM python:3.11-slim

WORKDIR /app

# Install system dependencies (including postgresql-client for pg_isready)
RUN apt-get update && apt-get install -y \
    gcc \
    curl \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY . .

# Copy and set entrypoint script permissions
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Create data and log directories
RUN mkdir -p /app/data /app/logs

# Expose ports - support all services
EXPOSE 5000 5001 5002

# Use entrypoint for startup initialization
ENTRYPOINT ["/app/entrypoint.sh"]

# Default startup command (will be overridden by docker-compose)
# Use admin service as default for backwards compatibility
CMD ["python3", "start_admin_service.py"]