#!/usr/bin/env python3
"""
Migration script to convert Chinese risk level values to English values in the database.
This script addresses the issue where old detection results have Chinese risk level values
that need to be converted to English for consistency.
"""

import sys
import os
from pathlib import Path

# Add the backend directory to the Python path
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

from database.connection import get_admin_db_session
from database.models import DetectionResult
from sqlalchemy import text
from utils.logger import setup_logger

logger = setup_logger()

# Risk level mapping from Chinese to English
RISK_LEVEL_MAPPING = {
    '无风险': 'no_risk',
    '低风险': 'low_risk', 
    '中风险': 'medium_risk',
    '高风险': 'high_risk'
}

def migrate_risk_levels():
    """Migrate Chinese risk level values to English values"""
    db = get_admin_db_session()
    
    try:
        logger.info("Starting risk level migration...")
        
        # Count records that need migration
        total_security = db.query(DetectionResult).filter(
            DetectionResult.security_risk_level.in_(list(RISK_LEVEL_MAPPING.keys()))
        ).count()
        
        total_compliance = db.query(DetectionResult).filter(
            DetectionResult.compliance_risk_level.in_(list(RISK_LEVEL_MAPPING.keys()))
        ).count()
        
        total_data = db.query(DetectionResult).filter(
            DetectionResult.data_risk_level.in_(list(RISK_LEVEL_MAPPING.keys()))
        ).count()
        
        logger.info(f"Found {total_security} security risk level records to migrate")
        logger.info(f"Found {total_compliance} compliance risk level records to migrate")
        logger.info(f"Found {total_data} data risk level records to migrate")
        
        # Migrate security risk levels
        for chinese_level, english_level in RISK_LEVEL_MAPPING.items():
            count = db.query(DetectionResult).filter(
                DetectionResult.security_risk_level == chinese_level
            ).count()
            
            if count > 0:
                db.query(DetectionResult).filter(
                    DetectionResult.security_risk_level == chinese_level
                ).update({DetectionResult.security_risk_level: english_level})
                logger.info(f"Migrated {count} security risk level records from '{chinese_level}' to '{english_level}'")
        
        # Migrate compliance risk levels
        for chinese_level, english_level in RISK_LEVEL_MAPPING.items():
            count = db.query(DetectionResult).filter(
                DetectionResult.compliance_risk_level == chinese_level
            ).count()
            
            if count > 0:
                db.query(DetectionResult).filter(
                    DetectionResult.compliance_risk_level == chinese_level
                ).update({DetectionResult.compliance_risk_level: english_level})
                logger.info(f"Migrated {count} compliance risk level records from '{chinese_level}' to '{english_level}'")
        
        # Migrate data risk levels
        for chinese_level, english_level in RISK_LEVEL_MAPPING.items():
            count = db.query(DetectionResult).filter(
                DetectionResult.data_risk_level == chinese_level
            ).count()
            
            if count > 0:
                db.query(DetectionResult).filter(
                    DetectionResult.data_risk_level == chinese_level
                ).update({DetectionResult.data_risk_level: english_level})
                logger.info(f"Migrated {count} data risk level records from '{chinese_level}' to '{english_level}'")
        
        # Commit all changes
        db.commit()
        logger.info("Risk level migration completed successfully!")
        
        # Verify migration
        remaining_chinese = db.query(DetectionResult).filter(
            DetectionResult.security_risk_level.in_(list(RISK_LEVEL_MAPPING.keys())) |
            DetectionResult.compliance_risk_level.in_(list(RISK_LEVEL_MAPPING.keys())) |
            DetectionResult.data_risk_level.in_(list(RISK_LEVEL_MAPPING.keys()))
        ).count()
        
        if remaining_chinese == 0:
            logger.info("Verification successful: No Chinese risk level values remaining")
        else:
            logger.warning(f"Verification failed: {remaining_chinese} Chinese risk level values still remain")
            
    except Exception as e:
        logger.error(f"Migration failed: {e}")
        db.rollback()
        raise
    finally:
        db.close()

if __name__ == "__main__":
    migrate_risk_levels()
