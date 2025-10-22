#!/bin/bash

# OpenGuardrails Platform Quick Start Script

echo "🛡️  OpenGuardrails Platform Quick Start"
echo "========================================"

# 检查Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker not installed, please install Docker first"
    exit 1
fi

# Create necessary directories
echo "📁 Create necessary directories..."
mkdir -p data logs

# Set permissions
chmod 755 data logs

# Start frontend (development mode)
echo "🚀 Start frontend service..."
cd frontend
npm install
npm run dev &
FRONTEND_PID=$!
cd ..

# Start backend (development mode)
echo "🚀 Start backend service..."
cd backend
pip install -r requirements.txt
python main.py &
BACKEND_PID=$!
cd ..

echo ""
echo "✅ Service starting..."
echo ""
echo "📊 Access Address:"
echo "   Frontend Management Interface: http://localhost:3000"
echo "   Backend API Documentation: http://localhost:5000/docs"
echo "   Guardrails API: http://localhost:5001/v1/guardrails"
echo ""
echo "🔧 Stop Service:"
echo "   Ctrl+C or run: kill $FRONTEND_PID $BACKEND_PID"
echo ""
echo "📧 Technical Support: thomas@openguardrails.com"

# Wait for user interrupt
wait