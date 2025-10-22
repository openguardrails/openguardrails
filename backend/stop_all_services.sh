#!/bin/bash
# Stop all services script

echo "Stopping OpenGuardrails - All Services"
echo "==========================================="

# Check if PID file exists
if [ -f "/tmp/openguardrails_services.pid" ]; then
    PIDS=$(cat /tmp/openguardrails_services.pid)
    echo "Found running services with PIDs: $PIDS"
    
    for PID in $PIDS; do
        if kill -0 $PID 2>/dev/null; then
            echo "Stopping service with PID: $PID"
            kill $PID
        else
            echo "Service with PID $PID is not running"
        fi
    done
    
    # Clean PID file
    rm -f /tmp/openguardrails_services.pid
    echo "All services stopped successfully!"
else
    echo "No PID file found. Trying to find and stop services by name..."
    
    # Find and stop Python processes
    pkill -f "start_detection_service.py"
    pkill -f "start_admin_service.py"
    pkill -f "start_proxy_service.py"
    
    echo "Attempted to stop all OpenGuardrails services"
fi

echo "Done!"