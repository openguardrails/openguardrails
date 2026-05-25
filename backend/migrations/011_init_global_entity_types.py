"""
Migration 011: Initialize global data security entity types and cleanup duplicates

This migration:
1. Removes duplicate entity types that were created per-user
2. Creates proper global entity types owned by super admin
3. Ensures all tenants can access these global defaults

Issue: Entity types were being created for each user during registration, causing duplicates
Solution: Create proper global entity types once, owned by super admin
"""

import sys
import os
from pathlib import Path

# Add backend directory to Python path
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

from sqlalchemy import text
from database.connection import engine
from database.models import Tenant, DataSecurityEntityType
from services.data_security_service import create_global_entity_types
from utils.logger import setup_logger

logger = setup_logger()


def upgrade():
    """Apply the migration"""
    with engine.connect() as conn:
        try:
            logger.info("Starting migration 011: Initialize global entity types")

            # Step 1: Get super admin tenant
            result = conn.execute(text("""
                SELECT id, email FROM tenants
                WHERE is_super_admin = true
                LIMIT 1
            """))
            admin = result.fetchone()

            if not admin:
                logger.warning("No super admin found, using first tenant as default")
                result = conn.execute(text("SELECT id, email FROM tenants LIMIT 1"))
                admin = result.fetchone()

            if not admin:
                logger.error("No tenants found in database. Please create super admin first.")
                raise Exception("No tenants found in database")

            admin_id, admin_email = admin
            logger.info(f"Using admin tenant: {admin_email} ({admin_id})")

            # Step 2: Delete all existing entity types (to clean up duplicates)
            logger.info("Cleaning up existing entity types...")
            result = conn.execute(text("DELETE FROM data_security_entity_types"))
            deleted_count = result.rowcount
            conn.commit()
            logger.info(f"Deleted {deleted_count} existing entity types")

            # Step 3: Create global entity types
            # Need to use ORM for this part as it requires the service
            from sqlalchemy.orm import Session
            session = Session(bind=conn)

            logger.info("Creating global entity types...")
            created_count = create_global_entity_types(session, str(admin_id))
            logger.info(f"Created {created_count} global entity types")

            # Step 4: Verify creation
            result = conn.execute(text("""
                SELECT entity_type, entity_type_name, category
                FROM data_security_entity_types
                WHERE is_global = true
            """))
            global_types = result.fetchall()

            logger.info(f"Verification: Found {len(global_types)} global entity types:")
            for entity_type, entity_type_name, category in global_types:
                logger.info(f"  - {entity_type}: {entity_type_name} (risk: {category})")

            conn.commit()
            logger.info("Migration 011 completed successfully!")

        except Exception as e:
            conn.rollback()
            logger.error(f"Migration 011 failed: {e}")
            raise


def downgrade():
    """Rollback the migration"""
    with engine.connect() as conn:
        try:
            logger.info("Rolling back migration 011: Removing global entity types")

            # Delete all global entity types
            result = conn.execute(text("""
                DELETE FROM data_security_entity_types
                WHERE is_global = true
            """))
            deleted_count = result.rowcount
            conn.commit()

            logger.info(f"Rollback completed: Deleted {deleted_count} global entity types")

        except Exception as e:
            conn.rollback()
            logger.error(f"Rollback failed: {e}")
            raise


if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "downgrade":
        downgrade()
    else:
        upgrade()
