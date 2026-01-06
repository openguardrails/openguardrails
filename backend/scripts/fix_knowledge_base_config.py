"""
Fix knowledge base configuration issues
- Activate disabled knowledge bases
- Adjust too high similarity threshold
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database.connection import get_db_session
from database.models import KnowledgeBase
from utils.logger import setup_logger

logger = setup_logger()

def fix_knowledge_base_config():
    """Fix knowledge base configuration"""
    db = get_db_session()
    try:
        changes_made = []
        
        # Get all knowledge bases
        knowledge_bases = db.query(KnowledgeBase).all()
        
        for kb in knowledge_bases:
            changes = []
            
            # Check if not activated
            if not kb.is_active:
                kb.is_active = True
                changes.append(f"Activate knowledge base")
            
            # Check if similarity threshold is too high
            if kb.similarity_threshold and kb.similarity_threshold > 0.8:
                old_threshold = kb.similarity_threshold
                kb.similarity_threshold = 0.7
                changes.append(f"Adjust similarity threshold: {old_threshold} -> 0.7")
            
            if changes:
                db.commit()
                logger.info(f"KB #{kb.id} ({kb.name}): {', '.join(changes)}")
                changes_made.append(f"KB #{kb.id} ({kb.name})")
        
        if changes_made:
            logger.info("=" * 60)
            logger.info(f"✅ Successfully fixed {len(changes_made)} knowledge base configurations")
            for change in changes_made:
                logger.info(f"  - {change}")
        else:
            logger.info("✅ All knowledge base configurations are normal, no need to fix")
            
    except Exception as e:
        logger.error(f"Fix failed: {e}")
        db.rollback()
        raise
    finally:
        db.close()

if __name__ == "__main__":
    logger.info("Start checking and fixing knowledge base configurations...")
    fix_knowledge_base_config()
    logger.info("Done!")

