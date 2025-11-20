#!/usr/bin/env python3
"""
Fix response templates for S8 and S10 categories
修复 S8 和 S10 类别的响应模板

This script fixes the incorrect template content for:
- S8 (Hate & Discrimination)
- S10 (Profanity)

Both were incorrectly set to the same content with mixed Chinese/English.
"""

import sys
import os
from pathlib import Path

# Add backend directory to Python path
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

from sqlalchemy import text
from database.connection import engine
from utils.logger import setup_logger
import json

logger = setup_logger()

# Correct templates as JSON
CORRECT_TEMPLATES = {
    'S8': {
        'en': "I'm sorry, but I cannot engage with content containing hate speech or discrimination.",
        'zh': "抱歉，我无法处理包含仇恨言论或歧视的内容。"
    },
    'S10': {
        'en': "I'm sorry, but I cannot respond to profanity or offensive language.",
        'zh': "抱歉，我无法回应脏话或冒犯性语言。"
    }
}

def fix_templates():
    """Fix the incorrect template content for S8 and S10"""
    with engine.connect() as conn:
        try:
            logger.info("开始修复 S8 和 S10 响应模板...")

            # Fix S8 templates
            logger.info("修复 S8 (Hate & Discrimination) 模板...")
            s8_json = json.dumps(CORRECT_TEMPLATES['S8'])

            result = conn.execute(text("""
                UPDATE response_templates
                SET template_content = :content
                WHERE category = 'S8' AND is_active = true
            """), {'content': s8_json})

            s8_count = result.rowcount
            logger.info(f"更新了 {s8_count} 个 S8 模板")

            # Fix S10 templates
            logger.info("修复 S10 (Profanity) 模板...")
            s10_json = json.dumps(CORRECT_TEMPLATES['S10'])

            result = conn.execute(text("""
                UPDATE response_templates
                SET template_content = :content
                WHERE category = 'S10' AND is_active = true
            """), {'content': s10_json})

            s10_count = result.rowcount
            logger.info(f"更新了 {s10_count} 个 S10 模板")

            # Verify the changes
            logger.info("验证更新结果...")

            for category, template in CORRECT_TEMPLATES.items():
                result = conn.execute(text("""
                    SELECT template_content, tenant_id, is_default
                    FROM response_templates
                    WHERE category = :category AND is_active = true
                    ORDER BY is_default
                """), {'category': category})

                templates = result.fetchall()
                logger.info(f"\n=== {category} 模板更新后内容 ===")
                for tmpl in templates:
                    logger.info(f"Tenant: {tmpl[1]}, Default: {tmpl[2]}")
                    logger.info(f"Content: {tmpl[0]}")
                    logger.info("---")

            conn.commit()
            logger.info("✅ S8 和 S10 模板修复完成!")

        except Exception as e:
            conn.rollback()
            logger.error(f"❌ 修复模板时出错: {e}")
            raise

def check_current_templates():
    """Check current template content before fixing"""
    with engine.connect() as conn:
        try:
            logger.info("=== 检查当前 S8 和 S10 模板内容 ===")

            for category in ['S8', 'S10']:
                result = conn.execute(text("""
                    SELECT template_content, tenant_id, is_default
                    FROM response_templates
                    WHERE category = :category AND is_active = true
                    ORDER BY is_default
                """), {'category': category})

                templates = result.fetchall()
                logger.info(f"\n--- 当前 {category} 模板 ---")
                for tmpl in templates:
                    logger.info(f"Tenant: {tmpl[1]}, Default: {tmpl[2]}")
                    logger.info(f"Content: {tmpl[0]}")
                    if "Everyone deserves" in str(tmpl[0]) or "平等对待" in str(tmpl[0]):
                        logger.warning("⚠️  发现问题的模板内容!")
                    logger.info("---")

        except Exception as e:
            logger.error(f"检查模板时出错: {e}")

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="修复 S8 和 S10 响应模板")
    parser.add_argument("--check", action="store_true", help="只检查当前模板，不修复")
    parser.add_argument("--fix", action="store_true", help="执行修复")

    args = parser.parse_args()

    if args.check:
        check_current_templates()
    elif args.fix:
        check_current_templates()
        print("\n" + "="*50)
        fix_templates()
        print("\n修复完成! 请重启服务以使更改生效。")
    else:
        print("请使用 --check 检查或 --fix 修复模板")
        print("例如: python fix_response_templates.py --check")
        print("      python fix_response_templates.py --fix")