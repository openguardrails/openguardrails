"""
恢复原始的知识库阈值设置
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database.connection import get_db_session
from database.models import KnowledgeBase
from utils.logger import setup_logger

logger = setup_logger()

def restore_original_thresholds():
    """恢复原始阈值"""
    db = get_db_session()
    try:
        # 恢复 KB #9 的阈值为 0.9
        kb9 = db.query(KnowledgeBase).filter(KnowledgeBase.id == 9).first()
        if kb9:
            old_threshold = kb9.similarity_threshold
            kb9.similarity_threshold = 0.9
            db.commit()
            logger.info(f"✅ KB #9 ({kb9.name}): 阈值已恢复 {old_threshold} -> 0.9")
        else:
            logger.warning("⚠️  KB #9 不存在")
        
        # 显示当前所有知识库的阈值
        logger.info("\n当前所有知识库阈值:")
        logger.info("=" * 60)
        kbs = db.query(KnowledgeBase).all()
        for kb in kbs:
            logger.info(f"KB #{kb.id} ({kb.name}): {kb.similarity_threshold}")
            
    except Exception as e:
        logger.error(f"恢复失败: {e}")
        db.rollback()
        raise
    finally:
        db.close()

if __name__ == "__main__":
    logger.info("开始恢复原始阈值...")
    restore_original_thresholds()
    logger.info("完成！")

