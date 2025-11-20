#!/usr/bin/env python3
"""
Fix S8 (Hate & Discrimination) response template
修复 S8 (歧视性内容) 响应模板

Update the template to use the correct rejection message.
"""

import sys
import os
from pathlib import Path

# Add backend directory to Python path
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

from sqlalchemy import text
from database.connection import engine, get_db_session
from database.models import ResponseTemplate
from utils.logger import setup_logger
import json

logger = setup_logger()

# Correct template for S8
CORRECT_S8_TEMPLATE = {
    'en': "Your message contains hate or discrimination language, which is not allowed.",
    'zh': "您的消息包含仇恨或歧视性语言，这是不允许的。"
}

def fix_s8_template():
    """Fix the S8 template content"""
    db = get_db_session()
    try:
        logger.info("开始修复 S8 (Hate & Discrimination) 响应模板...")

        # Find all S8 templates
        s8_templates = db.query(ResponseTemplate).filter_by(
            category='S8',
            is_active=True
        ).all()

        if not s8_templates:
            logger.warning("未找到 S8 模板，创建新的全局默认模板...")
            
            # Create a new global default S8 template
            new_template = ResponseTemplate(
                tenant_id=None,  # Global template
                category='S8',
                template_content=CORRECT_S8_TEMPLATE,
                is_default=True,
                is_active=True
            )
            db.add(new_template)
            db.commit()
            logger.info(f"✅ 创建了新的 S8 全局默认模板")
        else:
            logger.info(f"找到 {len(s8_templates)} 个 S8 模板")
            updated_count = 0
            
            for tmpl in s8_templates:
                old_content = tmpl.template_content
                logger.info(f"\n模板 ID: {tmpl.id}")
                logger.info(f"  Tenant: {tmpl.tenant_id}")
                logger.info(f"  Is Default: {tmpl.is_default}")
                logger.info(f"  旧内容: {old_content}")
                
                # Update the template
                tmpl.template_content = CORRECT_S8_TEMPLATE
                updated_count += 1
                
                logger.info(f"  新内容: {CORRECT_S8_TEMPLATE}")
                logger.info(f"  ✅ 已更新")
            
            db.commit()
            logger.info(f"\n✅ 成功更新了 {updated_count} 个 S8 模板!")

        # Verify the changes
        logger.info("\n=== 验证更新结果 ===")
        s8_templates = db.query(ResponseTemplate).filter_by(
            category='S8',
            is_active=True
        ).all()

        for tmpl in s8_templates:
            logger.info(f"\n模板 ID: {tmpl.id}")
            logger.info(f"  Tenant: {tmpl.tenant_id}")
            logger.info(f"  Is Default: {tmpl.is_default}")
            logger.info(f"  内容: {tmpl.template_content}")

        logger.info("\n✅ S8 模板修复完成!")
        
        # Invalidate template cache to force reload
        logger.info("\n刷新模板缓存...")
        try:
            from services.enhanced_template_service import enhanced_template_service
            import asyncio
            asyncio.run(enhanced_template_service.invalidate_cache())
            logger.info("✅ 模板缓存已刷新")
        except Exception as e:
            logger.warning(f"缓存刷新失败（需要手动重启服务）: {e}")

    except Exception as e:
        db.rollback()
        logger.error(f"修复 S8 模板时出错: {e}", exc_info=True)
        raise
    finally:
        db.close()

if __name__ == "__main__":
    fix_s8_template()

