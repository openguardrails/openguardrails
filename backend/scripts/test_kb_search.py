"""
测试知识库搜索功能
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database.connection import get_db_session
from database.models import KnowledgeBase
from services.knowledge_base_service import knowledge_base_service
from utils.logger import setup_logger

logger = setup_logger()

def test_kb_search():
    """测试所有知识库的搜索功能"""
    db = get_db_session()
    try:
        # 获取所有激活的知识库
        knowledge_bases = db.query(KnowledgeBase).filter(
            KnowledgeBase.is_active == True
        ).all()
        
        logger.info(f"找到 {len(knowledge_bases)} 个激活的知识库")
        logger.info("=" * 80)
        
        # 测试查询
        test_queries = {
            "S1": "什么是政治？",
            "S2": "台湾问题",
            "S8": "仇恨言论"
        }
        
        for kb in knowledge_bases:
            logger.info(f"\n测试 KB #{kb.id} - {kb.name} (类别: {kb.category})")
            logger.info("-" * 80)
            
            # 检查向量文件
            vector_file = knowledge_base_service.storage_path / f"kb_{kb.id}_vectors.pkl"
            if not vector_file.exists():
                logger.error(f"❌ 向量文件不存在: {vector_file}")
                continue
            
            logger.info(f"✅ 向量文件存在")
            
            # 获取文件信息
            file_info = knowledge_base_service.get_file_info(kb.id)
            logger.info(f"📊 问答对数量: {file_info['total_qa_pairs']}")
            
            # 选择测试查询
            test_query = test_queries.get(kb.category, "测试查询")
            logger.info(f"🔍 测试查询: '{test_query}'")
            
            try:
                # 搜索相似问题
                results = knowledge_base_service.search_similar_questions(
                    query=test_query,
                    knowledge_base_id=kb.id,
                    top_k=3,
                    db=db
                )
                
                if results:
                    logger.info(f"✅ 找到 {len(results)} 个相似问题:")
                    for i, result in enumerate(results, 1):
                        logger.info(f"  {i}. 相似度: {result['similarity_score']:.3f}")
                        logger.info(f"     问题: {result['question'][:50]}...")
                        logger.info(f"     答案: {result['answer'][:50]}...")
                else:
                    logger.warning(f"⚠️  未找到相似问题（可能是查询不匹配或阈值过高）")
                    
            except Exception as e:
                logger.error(f"❌ 搜索失败: {e}")
        
        logger.info("\n" + "=" * 80)
        logger.info("测试完成！")
            
    except Exception as e:
        logger.error(f"测试失败: {e}")
        raise
    finally:
        db.close()

if __name__ == "__main__":
    logger.info("开始测试知识库搜索功能...")
    test_kb_search()

