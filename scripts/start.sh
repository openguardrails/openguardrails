#!/bin/bash

# OpenGuardrails Platform Start Script

echo "🛡️  OpenGuardrails Platform Start Script"
echo "========================================"

# Check Python environment
if ! command -v python3 &> /dev/null; then
    echo "❌ Python3 not installed, please install Python3"
    echo "   Installation guide: https://www.python.org/downloads/"
    exit 1
fi

# Check pip
if ! command -v pip3 &> /dev/null; then
    echo "❌ pip3 not installed, please install pip3"
    exit 1
fi

# Check Node.js environment (for frontend)
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not installed, please install Node.js"
    echo "   Installation guide: https://nodejs.org/"
    exit 1
fi

# Check npm
if ! command -v npm &> /dev/null; then
    echo "❌ npm not installed, please install npm"
    exit 1
fi

# Create necessary directories
echo "📁 Create necessary directories..."
mkdir -p logs backend/config data/logs

# Set permissions
chmod 755 logs backend/config data/logs

# Check port occupancy
echo "🔍 Check port occupancy..."
if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
echo "⚠️  Port 3000 is occupied, please stop related services or modify configuration"
fi

if lsof -Pi :5000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "⚠️  Port 5000 is occupied, please stop related services or modify configuration"
fi

if lsof -Pi :5001 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "⚠️  Port 5001 is occupied, please stop related services or modify configuration"
fi

if lsof -Pi :5002 -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "⚠️  Port 5002 is occupied, please stop related services or modify configuration"
fi

# Stop possible running services
echo "🧹 Stop possible running services..."
if [ -f "/tmp/openguardrails_services.pid" ]; then
    PIDS=$(cat /tmp/openguardrails_services.pid)
    for PID in $PIDS; do
        if kill -0 $PID 2>/dev/null; then
            echo "Stop service PID: $PID"
            kill $PID 2>/dev/null
        fi
    done
    rm -f /tmp/openguardrails_services.pid
fi

# Stop possible running Python processes
pkill -f "start_detection_service.py" 2>/dev/null || true
pkill -f "start_admin_service.py" 2>/dev/null || true
pkill -f "start_proxy_service.py" 2>/dev/null || true

# Enter backend directory
cd backend

# Set environment variable
export PYTHONPATH="$PWD:$PYTHONPATH"

# Check Python dependencies
echo "📦 Check Python dependencies..."
if [ ! -f "requirements.txt" ]; then
    echo "❌ requirements.txt file not found"
    exit 1
fi

# Install Python dependencies
echo "📦 Install Python dependencies..."
pip3 install -r requirements.txt

# Start all services
echo "🚀 Start all services..."
bash start_all_services.sh &
SERVICES_PID=$!

# Wait for services to start
echo "⏳ Wait for services to start..."
sleep 5

# Check service status
echo "🔍 Check service status..."
for i in {1..30}; do
    if curl -f http://localhost:5000/health >/dev/null 2>&1; then
        echo "✅ Management service started (port 5000)"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "❌ Management service startup timeout"
    fi
    sleep 2
done

for i in {1..30}; do
    if curl -f http://localhost:5001/health >/dev/null 2>&1; then
        echo "✅ Detection service started (port 5001)"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "❌ Detection service startup timeout"
    fi
    sleep 2
done

for i in {1..30}; do
    if curl -f http://localhost:5002/health >/dev/null 2>&1; then
        echo "✅ Proxy service started (port 5002)"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "❌ Proxy service startup timeout"
    fi
    sleep 2
done

# Start frontend service
echo "🌐 Start frontend service..."
cd ../frontend

# Check frontend dependencies
if [ ! -f "package.json" ]; then
    echo "❌ package.json file not found"
    exit 1
fi

# Install frontend dependencies
echo "📦 Install frontend dependencies..."
npm install

# Start frontend service
echo "🚀 Start frontend service..."
npm run dev &
FRONTEND_PID=$!

# Wait for frontend service to start
echo "⏳ Wait for frontend service to start..."
for i in {1..30}; do
    if curl -f http://localhost:3000 >/dev/null 2>&1; then
        echo "✅ Frontend service started (port 3000)"
        break
    fi
    if [ $i -eq 30 ]; then
        echo "⚠️  Frontend service may take longer to start"
    fi
    sleep 2
done

# Save all PIDs
echo "$SERVICES_PID $FRONTEND_PID" > /tmp/openguardrails_all_services.pid

echo ""
echo "🎉 All services started!"
echo ""
echo "📊 Access address:"
echo "   🌐 Frontend management interface: http://localhost:3000"
echo "   📖 Management API documentation: http://localhost:5000/docs"
echo "   🛡️ Detection API: http://localhost:5001/v1/guardrails"
echo "   🔄 Proxy API: http://localhost:5002/v1/chat/completions"
echo ""
echo "🔑 Default admin account:"
echo "   Email: admin@openguardrails.com"
echo "   Password: admin123456"
echo "   ⚠️  Please modify the default password in the production environment!"
echo ""
echo "🔧 Common commands:"
echo "   View service logs: tail -f data/logs/*.log"
echo "   Stop all services: ./scripts/stop.sh"
echo "   Restart all services: ./scripts/stop.sh && ./scripts/start.sh"
echo ""
echo "📚 Documentation:"
echo "   Project documentation: https://github.com/openguardrails/openguardrails"
echo "   API documentation: http://localhost:5000/docs"
echo ""
echo "📧 Technical support: thomas@openguardrails.com"