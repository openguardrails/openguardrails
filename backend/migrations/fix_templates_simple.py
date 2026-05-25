#!/usr/bin/env python3
"""
Simple script to fix S8 and S10 templates using the production environment
"""
import subprocess
import sys

def run_fix():
    """Execute the template fix using the production Python environment"""

    # First, check current templates
    print("=== Check current template content ===")
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

        print(f"\\n--- Current {category} template ---")
        for tmpl in templates:
            print(f"Tenant: {tmpl.tenant_id}, Default: {tmpl.is_default}")
            print(f"Content: {tmpl.template_content}")
            if "Everyone deserves" in str(tmpl.template_content) or "Treat everyone equally" in str(tmpl.template_content):
                print("⚠️  Found problematic template content!")
            print("---")
finally:
    db.close()
        '''
    ]

    result = subprocess.run(check_cmd, capture_output=True, text=True)
    print(result.stdout)
    if result.stderr:
        print("Error:", result.stderr)

    # Ask user if they want to proceed with fix
    response = input("\nDo you want to continue fixing templates? (y/N): ")
    if response.lower() != 'y':
        print("Operation cancelled")
        return

    # Fix templates
    print("\n=== Start fixing templates ===")
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

        print(f"\\nFixing {category} template...")
        for tmpl in templates:
            old_content = str(tmpl.template_content)
            tmpl.template_content = template
            total_updated += 1
            print(f"  Updated template ID: {tmpl.id}, Tenant: {tmpl.tenant_id}")
            print(f"  Original content: {old_content[:100]}...")
            print(f"  New content: {json.dumps(template)[:100]}...")

    db.commit()
    print(f"\\n✅ Successfully updated {total_updated} templates!")

    # Verify updates
    print("\\n=== Verify update results ===")
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

    print("\nFix completed! Now you need to restart the service to make the changes take effect.")
    print("Run: sudo systemctl restart xiangxin_guardrails_detection.service")

if __name__ == "__main__":
    run_fix()