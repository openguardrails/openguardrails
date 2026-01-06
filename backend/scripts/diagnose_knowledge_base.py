"""
Knowledge base diagnostic tool
Check if knowledge base configurations and search functions are normal
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database.connection import get_db_session
from database.models import KnowledgeBase
from services.knowledge_base_service import knowledge_base_service
from utils.logger import setup_logger

logger = setup_logger()

def diagnose_knowledge_bases():
    """Diagnose all knowledge bases"""
    db = get_db_session()
    try:
        knowledge_bases = db.query(KnowledgeBase).all()
        
        logger.info("=" * 80)
        logger.info("Knowledge base diagnosis report")
        logger.info("=" * 80)
        
        issues = []
        warnings = []
        
        for kb in knowledge_bases:
            logger.info(f"\nKB #{kb.id} - {kb.name} (Category: {kb.category})")
            logger.info("-" * 80)
            
            # Check if activated
            if not kb.is_active:
                issue = f"KB #{kb.id} ({kb.name}) not activated"
                logger.error(f"  ❌ {issue}")
                issues.append(issue)
            else:
                logger.info(f"  ✅ Activated")
            
            # Check if similarity threshold is too high
            if kb.similarity_threshold > 0.8:
                warning = f"KB #{kb.id} ({kb.name}) similarity threshold too high ({kb.similarity_threshold})"
                logger.warning(f"  ⚠️  {warning}")
                warnings.append(warning)
            else:
                logger.info(f"  ✅ Similarity threshold: {kb.similarity_threshold}")
            
            # Check if vector file exists
            vector_file = knowledge_base_service.storage_path / f"kb_{kb.id}_vectors.pkl"
            if not vector_file.exists():
                issue = f"KB #{kb.id} ({kb.name}) vector file not exists"
                logger.error(f"  ❌ {issue}")
                issues.append(issue)
            else:
                file_info = knowledge_base_service.get_file_info(kb.id)
                logger.info(f"  ✅ Vector file exists ({file_info['total_qa_pairs']} QA pairs)")
            
            # Check if it is a global knowledge base
            if kb.is_global:
                logger.info(f"  🌐 Global knowledge base")
            else:
                logger.info(f"  📱 Application knowledge base (App ID: {kb.application_id})")
        
        # Print summary
        logger.info("\n" + "=" * 80)
        logger.info("Diagnosis summary")
        logger.info("=" * 80)
        
        if not issues and not warnings:
            logger.info("✅ All knowledge base configurations are normal!")
        else:
            if issues:
                logger.error(f"\n❌ Found {len(issues)} issues:")
                for issue in issues:
                    logger.error(f"  - {issue}")
            
            if warnings:
                logger.warning(f"\n⚠️  Found {len(warnings)} warnings:")
                for warning in warnings:
                    logger.warning(f"  - {warning}")
        
        logger.info("\nTips:")
        logger.info("  - Run fix_knowledge_base_config.py to automatically fix configuration issues")
        logger.info("  - Run rebuild_knowledge_base_vectors.py to rebuild missing vector files")
        logger.info("  - Run test_kb_search.py to test search functionality")
        
    except Exception as e:
        logger.error(f"Diagnosis failed: {e}")
        raise
    finally:
        db.close()

if __name__ == "__main__":
    diagnose_knowledge_bases()

