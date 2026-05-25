#!/bin/bash

echo "🔄 Restart OpenGuardrails Docker Service"
echo "=============================="

# Stop and delete existing containers
echo "1. Stop existing services..."
docker-compose down

# Clean old images (optional)
echo "2. Clean old images..."
docker image rm openguardrails-backend openguardrails-frontend 2>/dev/null || true

# Rebuild and start services
echo "3. Rebuild and start services..."
docker-compose up --build -d

echo "4. Wait for services to start..."
sleep 10

echo "5. Check service status..."
docker-compose ps

echo
echo "6. Check service health status..."
echo "Database:"
curl -f http://localhost:54321 2>/dev/null && echo "✅ Database port accessible" || echo "❌ Database port not accessible"

sleep 5

echo "Management Service:"
curl -f http://localhost:5000/health 2>/dev/null && echo "✅ Management service normal" || echo "❌ Management service abnormal"

echo "Detection Service:"
curl -f http://localhost:5001/health 2>/dev/null && echo "✅ Detection service normal" || echo "❌ Detection service abnormal"

echo "Proxy Service:"
curl -f http://localhost:5002/health 2>/dev/null && echo "✅ Proxy service normal" || echo "❌ Proxy service abnormal"

echo "Frontend Service:"
curl -f http://localhost:3000 2>/dev/null && echo "✅ Frontend service normal" || echo "❌ Frontend service abnormal"

echo
echo "7. Show latest logs..."
echo "--- Management Service Logs (Last 5 Lines) ---"
docker logs --tail 5 openguardrails-admin

echo
echo "--- Detection Service Logs (Last 5 Lines) ---"
docker logs --tail 5 openguardrails-detection

echo
echo "--- Proxy Service Logs (Last 5 Lines) ---"
docker logs --tail 5 openguardrails-proxy

echo
echo "🎉 Restart completed!"
echo "Management Platform: http://localhost:3000/platform/"
echo "Management API: http://localhost:5000/api/v1/"
echo "Detection API: http://localhost:5001/v1/guardrails"
echo "Proxy API: http://localhost:5002/v1/"
echo
echo "If the service is abnormal, please run: ./debug_services.sh"