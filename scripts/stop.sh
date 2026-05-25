#!/bin/bash

# OpenGuardrails Platform Stop Script

echo "🛡️  OpenGuardrails Platform Stop Script"
echo "========================================"

# Stop all services
echo "🛑 Stop all services..."

# Stop backend service
if [ -f "/tmp/openguardrails_services.pid" ]; then
    PIDS=$(cat /tmp/openguardrails_services.pid)
    echo "Stop backend service PIDs: $PIDS"
    
    for PID in $PIDS; do
        if kill -0 $PID 2>/dev/null; then
            echo "Stop service PID: $PID"
            kill $PID 2>/dev/null
        else
            echo "Service PID $PID is not running"
        fi
    done
    
    # Clean PID file
    rm -f /tmp/openguardrails_services.pid
    echo "✅ Backend service stopped"
else
    echo "No backend service PID file found, trying to stop by process name..."
    pkill -f "start_detection_service.py" 2>/dev/null || true
    pkill -f "start_admin_service.py" 2>/dev/null || true
    pkill -f "start_proxy_service.py" 2>/dev/null || true
    echo "✅ Backend service stopped"
fi

# Stop frontend service
if [ -f "/tmp/openguardrails_all_services.pid" ]; then
    PIDS=$(cat /tmp/openguardrails_all_services.pid)
    echo "Stop frontend service PIDs: $PIDS"
    
    for PID in $PIDS; do
        if kill -0 $PID 2>/dev/null; then
            echo "Stop frontend service PID: $PID"
            kill $PID 2>/dev/null
        else
            echo "Frontend service PID $PID is not running"
        fi
    done
    
    # Clean PID file
    rm -f /tmp/openguardrails_all_services.pid
    echo "✅ Frontend service stopped"
else
    echo "No frontend service PID file found, trying to stop by process name..."
    pkill -f "npm run dev" 2>/dev/null || true
    pkill -f "vite" 2>/dev/null || true
    echo "✅ Frontend service stopped"
fi

# Clean all related processes
echo "🧹 Clean all related processes..."
pkill -f "start_detection_service.py" 2>/dev/null || true
pkill -f "start_admin_service.py" 2>/dev/null || true
pkill -f "start_proxy_service.py" 2>/dev/null || true
pkill -f "npm run dev" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true

# Clean temporary files
echo "🧹 Clean temporary files..."
rm -f /tmp/openguardrails_services.pid
rm -f /tmp/openguardrails_all_services.pid

# Check if there are any related processes running
echo "🔍 Check remaining processes..."
REMAINING_PROCESSES=$(pgrep -f "start_.*_service.py|npm run dev|vite" 2>/dev/null || true)
if [ -n "$REMAINING_PROCESSES" ]; then
    echo "⚠️  Found remaining processes, force stop..."
    echo "$REMAINING_PROCESSES" | xargs kill -9 2>/dev/null || true
fi

echo ""
echo "✅ All services stopped!"
echo ""
echo "🔧 Clean options:"
read -p "Whether to clean log files? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "🧹 Clean log files..."
    rm -rf data/logs/*.log 2>/dev/null || true
    echo "✅ Log files cleaned"
fi

read -p "Whether to clean Python cache? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "🧹 Clean Python cache..."
    find . -name "__pycache__" -type d -exec rm -rf {} + 2>/dev/null || true
    find . -name "*.pyc" -type f -delete 2>/dev/null || true
    echo "✅ Python cache cleaned"
fi

read -p "Whether to clean Node.js cache? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "🧹 Clean Node.js cache..."
    rm -rf frontend/node_modules/.cache 2>/dev/null || true
    echo "✅ Node.js cache cleaned"
fi

echo ""
echo "🎉 Stop completed!"
echo ""
echo "📚 Restart:"
echo "   ./scripts/start.sh"
echo ""
echo "📧 Technical support: thomas@openguardrails.com"