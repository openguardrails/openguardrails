"""
Diagnose answer match issue
Help users understand why the suggested answer does not answer according to the answer library
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database.connection import get_db_session
from database.models import KnowledgeBase, Application
from utils.logger import setup_logger

logger = setup_logger()

def diagnose_answer_match_issue():
    """Diagnose answer match issue"""
    db = get_db_session()
    try:
        # Get all knowledge bases
        kbs = db.query(KnowledgeBase).filter(KnowledgeBase.is_active == True).all()
        
        logger.info("=" * 80)
        logger.info("Rejection answer library matching diagnosis report")
        logger.info("=" * 80)
        
        # Group by application
        app_kb_map = {}
        global_kbs = []
        
        for kb in kbs:
            if kb.is_global:
                global_kbs.append(kb)
            else:
                app_id = str(kb.application_id) if kb.application_id else "No application ID"
                if app_id not in app_kb_map:
                    app_kb_map[app_id] = []
                app_kb_map[app_id].append(kb)
        
        # Display global knowledge base
        if global_kbs:
            logger.info("\n🌐 Global knowledge base (all applications available):")
            logger.info("-" * 80)
            for kb in global_kbs:
                logger.info(f"  📚 KB #{kb.id} - {kb.name}")
                logger.info(f"     Category: {kb.category}")
                logger.info(f"     Scanner: {kb.scanner_type}:{kb.scanner_identifier}")
                logger.info(f"     Threshold: {kb.similarity_threshold}")
                logger.info(f"     Application ID: {kb.application_id}")
        
        # Display each application's exclusive knowledge base
        if app_kb_map:
            logger.info("\n📱 Application exclusive knowledge base:")
            logger.info("-" * 80)
            for app_id, kb_list in app_kb_map.items():
                # Get application information
                app = db.query(Application).filter(Application.id == app_id).first()
                app_name = app.name if app else "Unknown application"
                
                logger.info(f"\n   Application: {app_name}")
                logger.info(f"   Application ID: {app_id}")
                logger.info(f"   Knowledge base number: {len(kb_list)}")
                
                for kb in kb_list:
                    logger.info(f"\n    📚 KB #{kb.id} - {kb.name}")
                    logger.info(f"        Category: {kb.category}")
                    logger.info(f"        Scanner: {kb.scanner_type}:{kb.scanner_identifier}")
                    logger.info(f"        Threshold: {kb.similarity_threshold}")
        
        logger.info("\n" + "=" * 80)
        logger.info("Problem diagnosis tips")
        logger.info("=" * 80)
        logger.info("\nIf the suggested answer does not answer according to the answer library, the possible reasons are:")
        logger.info("\n1. 🎯 Application ID mismatch")
        logger.info("   - The knowledge base is associated with a specific application, but the test is using a different application")
        logger.info("   - Solution: Ensure that the correct application is selected during online testing")
        logger.info("   - Or set the knowledge base to global (is_global=True)")
        
        logger.info("\n2. 🔍 Scanner identifier mismatch")
        logger.info("   - The knowledge base's scanner_type:scanner_identifier does not match the detected one")
        logger.info("   - Solution: Check if the knowledge base's scanner configuration is correct")
        
        logger.info("\n3. 📊 Similarity threshold too high")
        logger.info("   - The similarity between the user's question and the question in the knowledge base is below the threshold")
        logger.info("   - Solution: Lower the similarity threshold (e.g., from 0.9 to 0.7)")
        
        logger.info("\n4. ❌ Knowledge base not activated")
        logger.info("   - The knowledge base's is_active is False")
        logger.info("   - Solution: Activate the knowledge base")
        
        logger.info("\n5. 📝 Knowledge base content mismatch")
        logger.info("   - There is no question-answer pair in the knowledge base that is similar to the user's question")
        logger.info("   - Solution: Supplement the knowledge base content or check the vector file")
        
        logger.info("\n" + "=" * 80)
        logger.info("Next operation suggestions")
        logger.info("=" * 80)
        logger.info("\n1. Check online test logs: Check the application_id used during actual call")
        logger.info("   tail -f data/logs/detection.log | grep 'Knowledge base search'")
        
        logger.info("\n2. Test knowledge base search:")
        logger.info("   python scripts/test_kb_search.py --kb-id <Knowledge base ID> --query \"Your test question\"")
        
        logger.info("\n3. If the application ID mismatch, you can:")
        logger.info("   - Method A: Set the knowledge base to global (recommended)")
        logger.info("   - Method B: Ensure that the correct application is selected during testing")
        
    finally:
        db.close()

if __name__ == "__main__":
    diagnose_answer_match_issue()

