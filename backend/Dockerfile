FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy dependency files
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy source code
COPY . .

# Create data and log directories
RUN mkdir -p /app/data /app/logs

# Expose ports - support all services
EXPOSE 5000 5001 5002

# Default startup command (will be overridden by docker-compose)
# Use admin service as default for backwards compatibility
CMD ["python", "start_admin_service.py"]