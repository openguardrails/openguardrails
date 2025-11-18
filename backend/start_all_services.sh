#!/bin/bash
# Start all three services script

echo "Starting OpenGuardrails - All Services"
echo "==========================================="

# Check Python environment
if ! command -v python3 &> /dev/null; then
    echo "Error: Python3 is not installed"
    exit 1
fi

# Set environment variable
export PYTHONPATH="$PWD:$PYTHONPATH"

# Run database migrations first (will be skipped if already up to date)
echo "Checking database migrations..."
python3 migrations/run_migrations.py || {
    echo "Warning: Migration check failed, continuing anyway..."
}
echo ""

# Start detection service (background running)
echo "Starting Detection Service on port 5001..."
python3 start_detection_service.py &
DETECTION_PID=$!
echo "Detection Service PID: $DETECTION_PID"

# Wait for one second
sleep 1

# Start management service (background running)
echo "Starting Admin Service on port 5000..."
python3 start_admin_service.py &
ADMIN_PID=$!
echo "Admin Service PID: $ADMIN_PID"

# Wait for one second
sleep 1

# Start proxy service (background running)
echo "Starting Proxy Service on port 5002..."
python3 start_proxy_service.py &
PROXY_PID=$!
echo "Proxy Service PID: $PROXY_PID"

echo ""
echo "All services started successfully!"
echo "================================="
echo "Admin Service:     http://localhost:5000 (PID: $ADMIN_PID)"
echo "Detection Service: http://localhost:5001 (PID: $DETECTION_PID)"
echo "Proxy Service:     http://localhost:5002 (PID: $PROXY_PID)"
echo ""
echo "To stop all services, run:"
echo "kill $DETECTION_PID $ADMIN_PID $PROXY_PID"
echo ""
echo "Service logs can be found in the data/logs directory"

# Save PID to file, for easy stopping
echo "$DETECTION_PID $ADMIN_PID $PROXY_PID" > /tmp/openguardrails_services.pid

# Wait for user input to stop services
echo "Press Ctrl+C to stop all services"
trap 'echo "Stopping all services..."; kill $DETECTION_PID $ADMIN_PID $PROXY_PID 2>/dev/null; exit 0' INT

# Keep script running
wait