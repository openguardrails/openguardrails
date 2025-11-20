"""
诊断拒答答案匹配问题
帮助用户理解为什么建议答案没有按照答案库来回答
"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database.connection import get_db_session
from database.models import KnowledgeBase, Application
from utils.logger import setup_logger

logger = setup_logger()

def diagnose_answer_match_issue():
    """诊断答案匹配问题"""
    db = get_db_session()
    try:
        # 获取所有知识库
        kbs = db.query(KnowledgeBase).filter(KnowledgeBase.is_active == True).all()
        
        logger.info("=" * 80)
        logger.info("拒答答案库匹配诊断报告")
        logger.info("=" * 80)
        
        # 按应用分组显示
        app_kb_map = {}
        global_kbs = []
        
        for kb in kbs:
            if kb.is_global:
                global_kbs.append(kb)
            else:
                app_id = str(kb.application_id) if kb.application_id else "无应用ID"
                if app_id not in app_kb_map:
                    app_kb_map[app_id] = []
                app_kb_map[app_id].append(kb)
        
        # 显示全局知识库
        if global_kbs:
            logger.info("\n🌐 全局知识库（所有应用可用）:")
            logger.info("-" * 80)
            for kb in global_kbs:
                logger.info(f"  📚 KB #{kb.id} - {kb.name}")
                logger.info(f"     类别: {kb.category}")
                logger.info(f"     扫描器: {kb.scanner_type}:{kb.scanner_identifier}")
                logger.info(f"     阈值: {kb.similarity_threshold}")
                logger.info(f"     应用ID: {kb.application_id}")
        
        # 显示每个应用的专属知识库
        if app_kb_map:
            logger.info("\n📱 应用专属知识库:")
            logger.info("-" * 80)
            for app_id, kb_list in app_kb_map.items():
                # 获取应用信息
                app = db.query(Application).filter(Application.id == app_id).first()
                app_name = app.name if app else "未知应用"
                
                logger.info(f"\n  应用: {app_name}")
                logger.info(f"  应用ID: {app_id}")
                logger.info(f"  知识库数量: {len(kb_list)}")
                
                for kb in kb_list:
                    logger.info(f"\n    📚 KB #{kb.id} - {kb.name}")
                    logger.info(f"       类别: {kb.category}")
                    logger.info(f"       扫描器: {kb.scanner_type}:{kb.scanner_identifier}")
                    logger.info(f"       阈值: {kb.similarity_threshold}")
        
        logger.info("\n" + "=" * 80)
        logger.info("问题排查提示")
        logger.info("=" * 80)
        logger.info("\n如果建议答案没有按照答案库来回答，可能的原因：")
        logger.info("\n1. 🎯 应用ID不匹配")
        logger.info("   - 知识库关联了特定应用，但测试时使用的是不同应用")
        logger.info("   - 解决方法：确保在线测试时选择了正确的应用")
        logger.info("   - 或者将知识库设置为全局（is_global=True）")
        
        logger.info("\n2. 🔍 扫描器标识不匹配")
        logger.info("   - 知识库的 scanner_type:scanner_identifier 与检测出的不一致")
        logger.info("   - 解决方法：检查知识库的扫描器配置是否正确")
        
        logger.info("\n3. 📊 相似度阈值过高")
        logger.info("   - 用户问题与知识库中的问题相似度低于阈值")
        logger.info("   - 解决方法：降低相似度阈值（如从 0.9 改为 0.7）")
        
        logger.info("\n4. ❌ 知识库未激活")
        logger.info("   - 知识库的 is_active 为 False")
        logger.info("   - 解决方法：激活知识库")
        
        logger.info("\n5. 📝 知识库内容不匹配")
        logger.info("   - 知识库中没有与用户问题相似的问答对")
        logger.info("   - 解决方法：补充知识库内容或检查向量文件")
        
        logger.info("\n" + "=" * 80)
        logger.info("下一步操作建议")
        logger.info("=" * 80)
        logger.info("\n1. 查看在线测试日志：检查实际调用时使用的 application_id")
        logger.info("   tail -f data/logs/detection.log | grep 'Knowledge base search'")
        
        logger.info("\n2. 测试知识库搜索：")
        logger.info("   python scripts/test_kb_search.py --kb-id <知识库ID> --query \"您的测试问题\"")
        
        logger.info("\n3. 如果是应用ID不匹配，可以：")
        logger.info("   - 方法A：将知识库设置为全局（推荐）")
        logger.info("   - 方法B：确保测试时选择了正确的应用")
        
    finally:
        db.close()

if __name__ == "__main__":
    diagnose_answer_match_issue()

