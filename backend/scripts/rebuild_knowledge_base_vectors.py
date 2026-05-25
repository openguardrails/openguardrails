"""
Rebuild knowledge base vector index
Fix missing or damaged vector files
"""
import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import glob
from pathlib import Path
from database.connection import get_db_session
from database.models import KnowledgeBase
from services.knowledge_base_service import knowledge_base_service
from utils.logger import setup_logger

logger = setup_logger()

def rebuild_vectors():
    """Rebuild all missing vector files"""
    db = get_db_session()
    try:
        # Get all knowledge bases
        knowledge_bases = db.query(KnowledgeBase).all()
        
        logger.info(f"Found {len(knowledge_bases)} knowledge bases in database")
        
        rebuilt_count = 0
        skipped_count = 0
        error_count = 0
        
        for kb in knowledge_bases:
            kb_id = kb.id
            kb_name = kb.name
            
            # Check if vector file exists
            vector_file = knowledge_base_service.storage_path / f"kb_{kb_id}_vectors.pkl"
            
            if vector_file.exists():
                logger.info(f"KB #{kb_id} ({kb_name}): Vector file already exists, skipping")
                skipped_count += 1
                continue
            
            # Find original file
            pattern = str(knowledge_base_service.storage_path / f"kb_{kb_id}_*.jsonl*")
            original_files = glob.glob(pattern)
            
            if not original_files:
                logger.warning(f"KB #{kb_id} ({kb_name}): No original file found, skipping")
                error_count += 1
                continue
            
            # Use the first matching file
            original_file = Path(original_files[0])
            logger.info(f"KB #{kb_id} ({kb_name}): Found original file {original_file.name}")
            
            try:
                # Read original file
                with open(original_file, 'rb') as f:
                    file_content = f.read()
                
                # Parse JSONL
                logger.info(f"KB #{kb_id} ({kb_name}): Parsing JSONL...")
                qa_pairs = knowledge_base_service.parse_jsonl_file(file_content)
                logger.info(f"KB #{kb_id} ({kb_name}): Parsed {len(qa_pairs)} QA pairs")
                
                # Create vector index
                logger.info(f"KB #{kb_id} ({kb_name}): Creating vector index...")
                vector_file_path = knowledge_base_service.create_vector_index(qa_pairs, kb_id)
                logger.info(f"KB #{kb_id} ({kb_name}): ✅ Vector index created at {vector_file_path}")
                
                rebuilt_count += 1
                
            except Exception as e:
                logger.error(f"KB #{kb_id} ({kb_name}): ❌ Failed to rebuild: {e}")
                error_count += 1
                continue
        
        # Print summary
        logger.info("=" * 60)
        logger.info("Rebuild Summary:")
        logger.info(f"  Total knowledge bases: {len(knowledge_bases)}")
        logger.info(f"  ✅ Successfully rebuilt: {rebuilt_count}")
        logger.info(f"  ⏭️  Skipped (already exist): {skipped_count}")
        logger.info(f"  ❌ Failed: {error_count}")
        logger.info("=" * 60)
        
    except Exception as e:
        logger.error(f"Fatal error: {e}")
        raise
    finally:
        db.close()

if __name__ == "__main__":
    logger.info("Starting knowledge base vector rebuild...")
    rebuild_vectors()
    logger.info("Done!")

