#!/usr/bin/env python3
"""
Auto-fix script for S8 and S10 templates without user interaction
自动化修复 S8 和 S10 模板脚本
"""

import subprocess
import sys

def run_auto_fix():
    """Execute the template fix automatically"""

    print("=== 开始自动修复模板 ===")

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
    s8_updated = 0
    s10_updated = 0

    # Fix S8 templates
    s8_templates = db.query(ResponseTemplate).filter_by(
        category="S8", is_active=True
    ).all()

    print(f"\\n=== 修复 S8 (Hate & Discrimination) 模板 ===")
    for tmpl in s8_templates:
        old_content = str(tmpl.template_content)
        # Check if it has the problematic content
        if "Everyone deserves" in old_content or "平等对待" in old_content or "discriminatory speech" in old_content:
            tmpl.template_content = correct_templates["S8"]
            total_updated += 1
            s8_updated += 1
            print(f"  ✅ 修复模板 ID: {tmpl.id}, Tenant: {tmpl.tenant_id}")
            print(f"     原内容: {old_content[:80]}...")
            print(f"     新内容: {json.dumps(correct_templates['S8'])}")

    # Fix S10 templates
    s10_templates = db.query(ResponseTemplate).filter_by(
        category="S10", is_active=True
    ).all()

    print(f"\\n=== 修复 S10 (Profanity) 模板 ===")
    for tmpl in s10_templates:
        old_content = str(tmpl.template_content)
        # Check if it has the problematic content
        if "Everyone deserves" in old_content or "平等对待" in old_content or "discriminatory speech" in old_content:
            tmpl.template_content = correct_templates["S10"]
            total_updated += 1
            s10_updated += 1
            print(f"  ✅ 修复模板 ID: {tmpl.id}, Tenant: {tmpl.tenant_id}")
            print(f"     原内容: {old_content[:80]}...")
            print(f"     新内容: {json.dumps(correct_templates['S10'])}")

    db.commit()
    print(f"\\n🎉 修复完成!")
    print(f"   S8 模板修复: {s8_updated} 个")
    print(f"   S10 模板修复: {s10_updated} 个")
    print(f"   总计修复: {total_updated} 个模板")

    # Final verification
    print(f"\\n=== 验证修复结果 ===")
    for category, template in correct_templates.items():
        # Get a sample template to verify
        sample = db.query(ResponseTemplate).filter_by(
            category=category, is_active=True
        ).first()
        if sample:
            print(f"{category}: {json.dumps(sample.template_content)}")

finally:
    db.close()
        '''
    ]

    result = subprocess.run(fix_cmd, capture_output=True, text=True)
    print(result.stdout)
    if result.stderr:
        print("错误:", result.stderr)

    print("\n✅ 模板修复完成! 现在需要重启检测服务以使更改生效。")

if __name__ == "__main__":
    run_auto_fix()