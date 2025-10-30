#!/usr/bin/env python3
"""
Start management service script - low concurrency management platform API
"""
import uvicorn
from config import settings

if __name__ == "__main__":
    print(f"Starting {settings.app_name} Admin Service...")
    print(f"Port: {settings.admin_port}")
    print(f"Workers: {settings.admin_uvicorn_workers}")
    print("Optimized for management operations")

    uvicorn.run(
        "admin_service:app",
        host=settings.host,
        port=settings.admin_port,
        reload=settings.debug,
        log_level=settings.log_level.lower(),
        workers=settings.admin_uvicorn_workers if not settings.debug else 1
    )