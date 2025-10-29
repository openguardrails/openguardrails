#!/usr/bin/env python3
"""
Migration: Fix JSON fields in detection_results table
Date: 2025-10-29
Description: Convert string '[]' values to proper JSON arrays and update column types to jsonb
"""

import os
import sys
sys.path.append(os.path.dirname(os.path.dirname(__file__)))

from database.connection import get_db_session
from sqlalchemy import text
from utils.logger import setup_logger

logger = setup_logger()

def run_migration():
    """Run the migration to fix JSON fields"""
    db = get_db_session()
    
    try:
        logger.info("Starting migration: Fix JSON fields in detection_results table")
        
        # Check current state
        total_count = db.execute(text('SELECT COUNT(*) FROM detection_results')).scalar()
        logger.info(f"Total detection_results records: {total_count}")
        
        # Fix data_categories field
        data_string_count = db.execute(text("SELECT COUNT(*) FROM detection_results WHERE data_categories::text = '[]'")).scalar()
        data_null_count = db.execute(text('SELECT COUNT(*) FROM detection_results WHERE data_categories IS NULL')).scalar()
        
        if data_string_count > 0:
            result = db.execute(text("UPDATE detection_results SET data_categories = '[]'::jsonb WHERE data_categories::text = '[]'")).rowcount
            logger.info(f"Updated {result} records with string data_categories to proper JSON arrays")
        
        if data_null_count > 0:
            result = db.execute(text("UPDATE detection_results SET data_categories = '[]'::jsonb WHERE data_categories IS NULL")).rowcount
            logger.info(f"Updated {result} records with NULL data_categories to proper JSON arrays")
        
        # Fix security_categories field
        security_string_count = db.execute(text("SELECT COUNT(*) FROM detection_results WHERE security_categories::text = '[]'")).scalar()
        if security_string_count > 0:
            result = db.execute(text("UPDATE detection_results SET security_categories = '[]'::jsonb WHERE security_categories::text = '[]'")).rowcount
            logger.info(f"Updated {result} records with string security_categories to proper JSON arrays")
        
        # Fix compliance_categories field
        compliance_string_count = db.execute(text("SELECT COUNT(*) FROM detection_results WHERE compliance_categories::text = '[]'")).scalar()
        if compliance_string_count > 0:
            result = db.execute(text("UPDATE detection_results SET compliance_categories = '[]'::jsonb WHERE compliance_categories::text = '[]'")).rowcount
            logger.info(f"Updated {result} records with string compliance_categories to proper JSON arrays")
        
        # Fix image_paths field
        image_string_count = db.execute(text("SELECT COUNT(*) FROM detection_results WHERE image_paths::text = '[]'")).scalar()
        if image_string_count > 0:
            result = db.execute(text("UPDATE detection_results SET image_paths = '[]'::jsonb WHERE image_paths::text = '[]'")).rowcount
            logger.info(f"Updated {result} records with string image_paths to proper JSON arrays")
        
        # Fix NULL risk level fields
        data_risk_null = db.execute(text('SELECT COUNT(*) FROM detection_results WHERE data_risk_level IS NULL')).scalar()
        if data_risk_null > 0:
            result = db.execute(text("UPDATE detection_results SET data_risk_level = 'no_risk' WHERE data_risk_level IS NULL")).rowcount
            logger.info(f"Updated {result} records with NULL data_risk_level to 'no_risk'")
        
        # Convert column types to jsonb
        logger.info("Converting column types to jsonb...")
        db.execute(text('ALTER TABLE detection_results ALTER COLUMN data_categories TYPE jsonb USING data_categories::jsonb'))
        db.execute(text('ALTER TABLE detection_results ALTER COLUMN security_categories TYPE jsonb USING security_categories::jsonb'))
        db.execute(text('ALTER TABLE detection_results ALTER COLUMN compliance_categories TYPE jsonb USING compliance_categories::jsonb'))
        db.execute(text('ALTER TABLE detection_results ALTER COLUMN image_paths TYPE jsonb USING image_paths::jsonb'))
        
        # Commit all changes
        db.commit()
        logger.info("All changes committed successfully")
        
        # Verify the fixes
        data_json_count = db.execute(text("SELECT COUNT(*) FROM detection_results WHERE jsonb_typeof(data_categories::jsonb) = 'array'")).scalar()
        security_json_count = db.execute(text("SELECT COUNT(*) FROM detection_results WHERE jsonb_typeof(security_categories::jsonb) = 'array'")).scalar()
        compliance_json_count = db.execute(text("SELECT COUNT(*) FROM detection_results WHERE jsonb_typeof(compliance_categories::jsonb) = 'array'")).scalar()
        image_json_count = db.execute(text("SELECT COUNT(*) FROM detection_results WHERE jsonb_typeof(image_paths::jsonb) = 'array'")).scalar()
        
        logger.info(f"Verification results:")
        logger.info(f"  - Records with proper JSON array data_categories: {data_json_count}")
        logger.info(f"  - Records with proper JSON array security_categories: {security_json_count}")
        logger.info(f"  - Records with proper JSON array compliance_categories: {compliance_json_count}")
        logger.info(f"  - Records with proper JSON array image_paths: {image_json_count}")
        
        if data_json_count == total_count and security_json_count == total_count and compliance_json_count == total_count and image_json_count == total_count:
            logger.info("✅ Migration completed successfully - all JSON fields are now proper arrays")
            return True
        else:
            logger.error("❌ Migration failed - some records still have incorrect JSON field types")
            return False
            
    except Exception as e:
        logger.error(f"Migration failed with error: {e}")
        db.rollback()
        return False
    finally:
        db.close()

if __name__ == "__main__":
    success = run_migration()
    sys.exit(0 if success else 1)
