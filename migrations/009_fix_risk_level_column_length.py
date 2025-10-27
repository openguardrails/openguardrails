"""
Migration 009: Fix risk level column length in detection_results table

Issue: VARCHAR(10) is too short for 'medium_risk' (11 characters)
Solution: Increase VARCHAR from 10 to 20 for all risk_level columns
"""

import sys
import os
from pathlib import Path

# Add backend directory to Python path
backend_dir = Path(__file__).parent.parent / "backend"
sys.path.insert(0, str(backend_dir))

from sqlalchemy import text
from database.connection import engine
from utils.logger import setup_logger

logger = setup_logger()

def upgrade():
    """
    Increase VARCHAR length for risk level columns from 10 to 20
    """
    with engine.connect() as conn:
        try:
            logger.info("Starting migration 009: Fix risk level column length")

            # Alter security_risk_level column
            logger.info("Altering detection_results.security_risk_level to VARCHAR(20)...")
            conn.execute(text("""
                ALTER TABLE detection_results
                ALTER COLUMN security_risk_level TYPE VARCHAR(20)
            """))

            # Alter compliance_risk_level column
            logger.info("Altering detection_results.compliance_risk_level to VARCHAR(20)...")
            conn.execute(text("""
                ALTER TABLE detection_results
                ALTER COLUMN compliance_risk_level TYPE VARCHAR(20)
            """))

            # Alter data_risk_level column
            logger.info("Altering detection_results.data_risk_level to VARCHAR(20)...")
            conn.execute(text("""
                ALTER TABLE detection_results
                ALTER COLUMN data_risk_level TYPE VARCHAR(20)
            """))

            # Also fix risk_level in response_templates table
            logger.info("Altering response_templates.risk_level to VARCHAR(20)...")
            conn.execute(text("""
                ALTER TABLE response_templates
                ALTER COLUMN risk_level TYPE VARCHAR(20)
            """))

            # Also fix sensitivity_trigger_level in risk_type_config table
            logger.info("Altering risk_type_config.sensitivity_trigger_level to VARCHAR(20)...")
            conn.execute(text("""
                ALTER TABLE risk_type_config
                ALTER COLUMN sensitivity_trigger_level TYPE VARCHAR(20)
            """))

            conn.commit()
            logger.info("Migration 009 completed successfully!")

        except Exception as e:
            conn.rollback()
            logger.error(f"Migration 009 failed: {e}")
            raise

def downgrade():
    """
    Revert VARCHAR length back to 10 (not recommended, will cause data truncation)
    """
    with engine.connect() as conn:
        try:
            logger.info("Starting downgrade of migration 009")
            logger.warning("Downgrading column lengths may truncate data!")

            # Revert detection_results columns
            logger.info("Reverting detection_results columns to VARCHAR(10)...")
            conn.execute(text("""
                ALTER TABLE detection_results
                ALTER COLUMN security_risk_level TYPE VARCHAR(10)
            """))

            conn.execute(text("""
                ALTER TABLE detection_results
                ALTER COLUMN compliance_risk_level TYPE VARCHAR(10)
            """))

            conn.execute(text("""
                ALTER TABLE detection_results
                ALTER COLUMN data_risk_level TYPE VARCHAR(10)
            """))

            # Revert response_templates
            logger.info("Reverting response_templates.risk_level to VARCHAR(10)...")
            conn.execute(text("""
                ALTER TABLE response_templates
                ALTER COLUMN risk_level TYPE VARCHAR(10)
            """))

            # Revert risk_type_config
            logger.info("Reverting risk_type_config.sensitivity_trigger_level to VARCHAR(10)...")
            conn.execute(text("""
                ALTER TABLE risk_type_config
                ALTER COLUMN sensitivity_trigger_level TYPE VARCHAR(10)
            """))

            conn.commit()
            logger.info("Migration 009 downgrade completed successfully!")

        except Exception as e:
            conn.rollback()
            logger.error(f"Migration 009 downgrade failed: {e}")
            raise

if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "downgrade":
        downgrade()
    else:
        upgrade()
