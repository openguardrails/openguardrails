#!/usr/bin/env python3
"""
Simple script to fix S8 and S10 templates using the production environment
"""
import subprocess
import sys

def run_fix():
    """Execute the template fix using the production Python environment"""

    # First, check current templates
    print("=== 检查当前模板内容 ===")
    check_cmd = [
        '/home/ecs-user/miniconda3/envs/guardrails/bin/python',
        '-c',
        '''
import sys
sys.path.append("/home/ecs-user/production/openguardrails/backend")
from database.connection import get_db_session
from database.models import ResponseTemplate

db = get_db_session()
try:
    for category in ["S8", "S10"]:
        templates = db.query(ResponseTemplate).filter_by(
            category=category, is_active=True
        ).order_by(ResponseTemplate.is_default).all()

        print(f"\\n--- 当前 {category} 模板 ---")
        for tmpl in templates:
            print(f"Tenant: {tmpl.tenant_id}, Default: {tmpl.is_default}")
            print(f"Content: {tmpl.template_content}")
            if "Everyone deserves" in str(tmpl.template_content) or "平等对待" in str(tmpl.template_content):
                print("⚠️  发现问题的模板内容!")
            print("---")
finally:
    db.close()
        '''
    ]

    result = subprocess.run(check_cmd, capture_output=True, text=True)
    print(result.stdout)
    if result.stderr:
        print("错误:", result.stderr)

    # Ask user if they want to proceed with fix
    response = input("\n是否要继续修复模板? (y/N): ")
    if response.lower() != 'y':
        print("操作已取消")
        return

    # Fix templates
    print("\n=== 开始修复模板 ===")
    fix_cmd = [
        '/home/ecs-user/miniconda3/envs/guardrails/bin/python',
        '-c',
        '''
import sys
sys.path.append("/home/ecs-user/production/openguardrails/backend")
from database.connection import get_db_session
from database.models import ResponseTemplate
import json

# Correct templates
correct_templates = {
    "S8": {
        "en": "I am sorry, but I cannot engage with content containing hate speech or discrimination.",
        "zh": "抱歉，我无法处理包含仇恨言论或歧视的内容。"
    },
    "S10": {
        "en": "I am sorry, but I cannot respond to profanity or offensive language.",
        "zh": "抱歉，我无法回应脏话或冒犯性语言。"
    }
}

db = get_db_session()
try:
    total_updated = 0
    for category, template in correct_templates.items():
        templates = db.query(ResponseTemplate).filter_by(
            category=category, is_active=True
        ).all()

        print(f"\\n修复 {category} 模板...")
        for tmpl in templates:
            old_content = str(tmpl.template_content)
            tmpl.template_content = template
            total_updated += 1
            print(f"  更新模板 ID: {tmpl.id}, Tenant: {tmpl.tenant_id}")
            print(f"  原内容: {old_content[:100]}...")
            print(f"  新内容: {json.dumps(template)[:100]}...")

    db.commit()
    print(f"\\n✅ 成功更新了 {total_updated} 个模板!")

    # Verify updates
    print("\\n=== 验证更新结果 ===")
    for category in ["S8", "S10"]:
        templates = db.query(ResponseTemplate).filter_by(
            category=category, is_active=True
        ).order_by(ResponseTemplate.is_default).first()

        if templates:
            content = templates.template_content
            print(f"{category}: {content}")

finally:
    db.close()
        '''
    ]

    result = subprocess.run(fix_cmd, capture_output=True, text=True)
    print(result.stdout)
    if result.stderr:
        print("错误:", result.stderr)

    print("\n修复完成! 现在需要重启服务以使更改生效。")
    print("运行: sudo systemctl restart xiangxin_guardrails_detection.service")

if __name__ == "__main__":
    run_fix()