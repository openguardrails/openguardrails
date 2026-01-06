"""
Restore original knowledge base threshold settings
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database.connection import get_db_session
from database.models import KnowledgeBase
from utils.logger import setup_logger

logger = setup_logger()

def restore_original_thresholds():
    """Restore original thresholds"""
    db = get_db_session()
    try:
        # Restore KB #9 threshold to 0.9
        kb9 = db.query(KnowledgeBase).filter(KnowledgeBase.id == 9).first()
        if kb9:
            old_threshold = kb9.similarity_threshold
            kb9.similarity_threshold = 0.9
            db.commit()
            logger.info(f"✅ KB #9 ({kb9.name}): Threshold restored {old_threshold} -> 0.9")
        else:
            logger.warning("⚠️  KB #9 not exists")
        
        # Show current all knowledge bases thresholds
        logger.info("\nCurrent all knowledge bases thresholds:")
        logger.info("=" * 60)
        kbs = db.query(KnowledgeBase).all()
        for kb in kbs:
            logger.info(f"KB #{kb.id} ({kb.name}): {kb.similarity_threshold}")
            
    except Exception as e:
        logger.error(f"Restore failed: {e}")
        db.rollback()
        raise
    finally:
        db.close()

if __name__ == "__main__":
    logger.info("Start restoring original thresholds...")
    restore_original_thresholds()
    logger.info("Done!")

