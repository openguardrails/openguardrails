"""
修复知识库配置问题
- 激活被禁用的知识库
- 调整过高的相似度阈值
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database.connection import get_db_session
from database.models import KnowledgeBase
from utils.logger import setup_logger

logger = setup_logger()

def fix_knowledge_base_config():
    """修复知识库配置"""
    db = get_db_session()
    try:
        changes_made = []
        
        # 获取所有知识库
        knowledge_bases = db.query(KnowledgeBase).all()
        
        for kb in knowledge_bases:
            changes = []
            
            # 检查是否未激活
            if not kb.is_active:
                kb.is_active = True
                changes.append(f"激活知识库")
            
            # 检查相似度阈值是否过高
            if kb.similarity_threshold and kb.similarity_threshold > 0.8:
                old_threshold = kb.similarity_threshold
                kb.similarity_threshold = 0.7
                changes.append(f"调整相似度阈值: {old_threshold} -> 0.7")
            
            if changes:
                db.commit()
                logger.info(f"KB #{kb.id} ({kb.name}): {', '.join(changes)}")
                changes_made.append(f"KB #{kb.id} ({kb.name})")
        
        if changes_made:
            logger.info("=" * 60)
            logger.info(f"✅ 已修复 {len(changes_made)} 个知识库的配置")
            for change in changes_made:
                logger.info(f"  - {change}")
        else:
            logger.info("✅ 所有知识库配置正常，无需修复")
            
    except Exception as e:
        logger.error(f"修复失败: {e}")
        db.rollback()
        raise
    finally:
        db.close()

if __name__ == "__main__":
    logger.info("开始检查并修复知识库配置...")
    fix_knowledge_base_config()
    logger.info("完成！")

