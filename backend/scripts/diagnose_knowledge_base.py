"""
知识库诊断工具
用于检查知识库配置和搜索功能是否正常
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
    """诊断所有知识库"""
    db = get_db_session()
    try:
        knowledge_bases = db.query(KnowledgeBase).all()
        
        logger.info("=" * 80)
        logger.info("知识库诊断报告")
        logger.info("=" * 80)
        
        issues = []
        warnings = []
        
        for kb in knowledge_bases:
            logger.info(f"\nKB #{kb.id} - {kb.name} (类别: {kb.category})")
            logger.info("-" * 80)
            
            # 检查激活状态
            if not kb.is_active:
                issue = f"KB #{kb.id} ({kb.name}) 未激活"
                logger.error(f"  ❌ {issue}")
                issues.append(issue)
            else:
                logger.info(f"  ✅ 已激活")
            
            # 检查相似度阈值
            if kb.similarity_threshold > 0.8:
                warning = f"KB #{kb.id} ({kb.name}) 相似度阈值过高 ({kb.similarity_threshold})"
                logger.warning(f"  ⚠️  {warning}")
                warnings.append(warning)
            else:
                logger.info(f"  ✅ 相似度阈值: {kb.similarity_threshold}")
            
            # 检查向量文件
            vector_file = knowledge_base_service.storage_path / f"kb_{kb.id}_vectors.pkl"
            if not vector_file.exists():
                issue = f"KB #{kb.id} ({kb.name}) 向量文件不存在"
                logger.error(f"  ❌ {issue}")
                issues.append(issue)
            else:
                file_info = knowledge_base_service.get_file_info(kb.id)
                logger.info(f"  ✅ 向量文件存在 ({file_info['total_qa_pairs']} 个问答对)")
            
            # 检查是否为全局知识库
            if kb.is_global:
                logger.info(f"  🌐 全局知识库")
            else:
                logger.info(f"  📱 应用知识库 (App ID: {kb.application_id})")
        
        # 打印总结
        logger.info("\n" + "=" * 80)
        logger.info("诊断总结")
        logger.info("=" * 80)
        
        if not issues and not warnings:
            logger.info("✅ 所有知识库配置正常！")
        else:
            if issues:
                logger.error(f"\n❌ 发现 {len(issues)} 个问题:")
                for issue in issues:
                    logger.error(f"  - {issue}")
            
            if warnings:
                logger.warning(f"\n⚠️  发现 {len(warnings)} 个警告:")
                for warning in warnings:
                    logger.warning(f"  - {warning}")
        
        logger.info("\n提示:")
        logger.info("  - 运行 fix_knowledge_base_config.py 可以自动修复配置问题")
        logger.info("  - 运行 rebuild_knowledge_base_vectors.py 可以重建缺失的向量文件")
        logger.info("  - 运行 test_kb_search.py 可以测试搜索功能")
        
    except Exception as e:
        logger.error(f"诊断失败: {e}")
        raise
    finally:
        db.close()

if __name__ == "__main__":
    diagnose_knowledge_bases()

