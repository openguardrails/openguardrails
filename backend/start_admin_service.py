#!/usr/bin/env python3
"""
Start management service script - low concurrency management platform API
"""
import uvicorn
from config import settings
from utils.logger import setup_logger

logger = setup_logger()

def run_migrations():
    """Run database migrations before starting the service"""
    try:
        logger.info("=" * 60)
        logger.info("Running database migrations before service startup...")
        logger.info("=" * 60)
        
        from migrations.run_migrations import run_migrations
        executed, failed = run_migrations(dry_run=False)
        
        if failed > 0:
            logger.error("Database migrations failed! Service will not start.")
            raise Exception(f"Migration failed: {failed} migration(s) failed")
        
        if executed > 0:
            logger.info(f"Successfully executed {executed} pending migration(s)")
        else:
            logger.info("All migrations are up to date")
            
        logger.info("=" * 60)
        
    except Exception as e:
        logger.error(f"Migration check failed: {e}")
        logger.warning("Continuing service startup anyway (migration may have run elsewhere)...")

if __name__ == "__main__":
    # Run migrations first (only admin service does this to avoid race conditions)
    run_migrations()
    
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