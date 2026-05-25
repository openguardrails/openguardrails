#!/usr/bin/env python3
"""
Reset the database schema and data (DANGEROUS):
- Drops all tables
- Recreates tables
- Recreates super admin account and default configs/templates

Usage:
  python backend/scripts/reset_db.py

Environment:
  Uses DATABASE_URL from backend/.env via pydantic settings
"""

import sys
import os
import asyncio

# Ensure backend path is in sys.path when running directly
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_ROOT = os.path.abspath(os.path.join(CURRENT_DIR, ".."))
if BACKEND_ROOT not in sys.path:
    sys.path.insert(0, BACKEND_ROOT)

from database.connection import engine, Base, init_db  # type: ignore
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError


def drop_all_tables():
    """Drop all tables using SQLAlchemy metadata."""
    # Use metadata drop_all which respects foreign keys ordering
    Base.metadata.drop_all(bind=engine)


def recreate_schema_and_seed():
    """Recreate tables and seed initial data."""
    # Recreate tables
    Base.metadata.create_all(bind=engine)
    # Run async init for seeding default data and super admin
    asyncio.run(init_db())


def main():
    print("WARNING: This will ERASE ALL DATA in the configured database!\n")
    drop_all_tables()
    print("All tables dropped.")
    recreate_schema_and_seed()
    print("Schema recreated and default data initialized.")


if __name__ == "__main__":
    main()
