#!/usr/bin/env python3
"""
PostgreSQL database initialization script
Create database and necessary configurations
"""

import asyncio
import asyncpg
from config import settings
from utils.logger import setup_logger

logger = setup_logger()

async def create_database():
    """Create PostgreSQL database"""
    try:
        # Parse database URL
        url_parts = settings.database_url.replace("postgresql://", "").split("/")
        connection_part = url_parts[0]
        db_name = url_parts[1] if len(url_parts) > 1 else "openguardrails"
        
        user_pass, host_port = connection_part.split("@")
        user, password = user_pass.split(":")
        host, port = host_port.split(":")
        
        # Connect to default database
        conn = await asyncpg.connect(
            user=user,
            password=password,
            host=host,
            port=port,
            database='postgres'  # Connect to default database
        )
        
        try:
            # Check if database exists
            exists = await conn.fetchval(
                "SELECT 1 FROM pg_database WHERE datname = $1", db_name
            )
            
            if not exists:
                # Create database
                await conn.execute(f'CREATE DATABASE "{db_name}"')
                logger.info(f"Database '{db_name}' created successfully")
            else:
                logger.info(f"Database '{db_name}' already exists")
                
        finally:
            await conn.close()
            
    except Exception as e:
        logger.error(f"Failed to create database: {e}")
        raise

async def main():
    """Main function"""
    logger.info("Starting PostgreSQL database initialization...")
    await create_database()
    logger.info("PostgreSQL database initialization completed!")

if __name__ == "__main__":
    asyncio.run(main())