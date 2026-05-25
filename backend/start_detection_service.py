#!/usr/bin/env python3
"""
Start detection service script - high-concurrency detection API
"""
import uvicorn
from config import settings

if __name__ == "__main__":
    print(f"Starting {settings.app_name} Detection Service...")
    print(f"Port: {settings.detection_port}")
    print(f"Workers: {settings.detection_uvicorn_workers}")
    print(f"Max Concurrent: {settings.detection_max_concurrent_requests}")
    print("Optimized for high-concurrency detection API")
    
    uvicorn.run(
        "detection_service:app",
        host=settings.host,
        port=settings.detection_port,
        reload=settings.debug,
        log_level=settings.log_level.lower(),
        workers=settings.detection_uvicorn_workers if not settings.debug else 1
    )