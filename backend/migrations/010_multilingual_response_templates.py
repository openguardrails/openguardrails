"""
Migration 010: Convert response template content to multilingual JSON format

Issue: template_content is currently TEXT, needs to support multiple languages
Solution: Convert template_content to JSON format: {"en": "...", "zh": "...", ...}
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

logger = setup_logger()

# Default multilingual templates for each category
DEFAULT_TEMPLATES = {
    'S1': {
        'en': "I'm sorry, but I cannot discuss general political topics. Please ask about something else.",
        'zh': "抱歉，我无法讨论一般政治话题。请询问其他内容。"
    },
    'S2': {
        'en': "I'm sorry, but I cannot discuss sensitive political topics. This violates content policy.",
        'zh': "抱歉，我无法讨论敏感政治话题。这违反了内容政策。"
    },
    'S3': {
        'en': "I'm sorry, but I cannot engage with content that insults national symbols or leaders.",
        'zh': "抱歉，我无法处理侮辱国家象征或领导人的内容。"
    },
    'S4': {
        'en': "I'm sorry, but I cannot provide content that may harm minors.",
        'zh': "抱歉，我无法提供可能伤害未成年人的内容。"
    },
    'S5': {
        'en': "I'm sorry, but I cannot discuss violent crimes. If you need help, please contact local authorities.",
        'zh': "抱歉，我无法讨论暴力犯罪。如需帮助，请联系当地执法部门。"
    },
    'S6': {
        'en': "I'm sorry, but I cannot provide information about non-violent crimes.",
        'zh': "抱歉，我无法提供有关非暴力犯罪的信息。"
    },
    'S7': {
        'en': "I'm sorry, but I cannot provide pornographic or sexually explicit content.",
        'zh': "抱歉，我无法提供色情或性暗示内容。"
    },
    'S8': {
        'en': "I'm sorry, but I cannot engage with content containing hate speech or discrimination.",
        'zh': "抱歉，我无法处理包含仇恨言论或歧视的内容。"
    },
    'S9': {
        'en': "I'm sorry, but I detected a prompt attack attempt. Please rephrase your question appropriately.",
        'zh': "抱歉，我检测到了提示词攻击尝试。请适当地重新表述您的问题。"
    },
    'S10': {
        'en': "I'm sorry, but I cannot respond to profanity or offensive language.",
        'zh': "抱歉，我无法回应脏话或冒犯性语言。"
    },
    'S11': {
        'en': "I'm sorry, but I cannot process requests involving privacy invasion.",
        'zh': "抱歉，我无法处理涉及侵犯隐私的请求。"
    },
    'S12': {
        'en': "I'm sorry, but I cannot provide information about commercial violations.",
        'zh': "抱歉，我无法提供有关商业违法违规的信息。"
    },
    'S13': {
        'en': "I'm sorry, but I cannot assist with intellectual property infringement.",
        'zh': "抱歉，我无法协助知识产权侵权行为。"
    },
    'S14': {
        'en': "I'm sorry, but I cannot engage with harassing or abusive content.",
        'zh': "抱歉，我无法处理骚扰或辱骂性内容。"
    },
    'S15': {
        'en': "I'm sorry, but I cannot provide information about weapons of mass destruction.",
        'zh': "抱歉，我无法提供有关大规模杀伤性武器的信息。"
    },
    'S16': {
        'en': "I'm sorry, but I cannot provide content about self-harm. If you're in crisis, please contact a mental health professional or crisis helpline.",
        'zh': "抱歉，我无法提供有关自我伤害的内容。如果您处于危机中，请联系心理健康专业人员或危机热线。"
    },
    'S17': {
        'en': "I'm sorry, but I cannot discuss sexual crimes. If you need help, please contact appropriate authorities.",
        'zh': "抱歉，我无法讨论性犯罪。如需帮助，请联系相关机构。"
    },
    'S18': {
        'en': "I'm sorry, but I cannot process threatening or intimidating content.",
        'zh': "抱歉，我无法处理威胁或恐吓性内容。"
    },
    'S19': {
        'en': "I'm sorry, but I cannot provide professional advice in this area. Please consult with qualified professionals.",
        'zh': "抱歉，我无法在此领域提供专业建议。请咨询合格的专业人士。"
    },
    'default': {
        'en': "I'm sorry, but I cannot answer this question. If you have any questions, please contact customer service.",
        'zh': "抱歉，我无法回答这个问题。如有任何疑问，请联系客服。"
    }
}

def upgrade():
    """
    Convert template_content from TEXT to JSON format
    """
    with engine.connect() as conn:
        try:
            logger.info("Starting migration 010: Convert response templates to multilingual JSON format")

            # Step 1: Create a temporary column for new JSON data
            logger.info("Adding temporary column template_content_json...")
            conn.execute(text("""
                ALTER TABLE response_templates
                ADD COLUMN IF NOT EXISTS template_content_json JSONB
            """))
            conn.commit()

            # Step 2: Migrate existing data
            logger.info("Migrating existing template content to JSON format...")

            # Get all existing templates
            result = conn.execute(text("""
                SELECT id, category, template_content
                FROM response_templates
            """))

            templates = result.fetchall()

            for template in templates:
                template_id, category, old_content = template

                # Determine if content is in English or Chinese based on content
                # If content contains Chinese characters, treat as Chinese, otherwise English
                is_chinese = any('\u4e00' <= char <= '\u9fff' for char in str(old_content))

                # Get default templates for this category
                default_template = DEFAULT_TEMPLATES.get(category, DEFAULT_TEMPLATES['default'])

                # Create multilingual content
                if is_chinese:
                    # Original content is Chinese, use default English
                    new_content = {
                        'en': default_template['en'],
                        'zh': old_content
                    }
                else:
                    # Original content is English, use default Chinese
                    new_content = {
                        'en': old_content,
                        'zh': default_template['zh']
                    }

                # Update the row with JSON content
                import json
                json_str = json.dumps(new_content).replace("'", "''")  # Escape single quotes for SQL
                conn.execute(
                    text(f"""
                        UPDATE response_templates
                        SET template_content_json = '{json_str}'::jsonb
                        WHERE id = {template_id}
                    """)
                )

            conn.commit()
            logger.info(f"Migrated {len(templates)} templates to JSON format")

            # Step 3: Drop old column and rename new column
            logger.info("Replacing old template_content column with JSON version...")
            conn.execute(text("""
                ALTER TABLE response_templates
                DROP COLUMN template_content
            """))

            conn.execute(text("""
                ALTER TABLE response_templates
                RENAME COLUMN template_content_json TO template_content
            """))

            # Step 4: Add NOT NULL constraint
            conn.execute(text("""
                ALTER TABLE response_templates
                ALTER COLUMN template_content SET NOT NULL
            """))

            conn.commit()
            logger.info("Migration 010 completed successfully!")

        except Exception as e:
            conn.rollback()
            logger.error(f"Migration 010 failed: {e}")
            raise

def downgrade():
    """
    Revert JSON format back to TEXT (uses English content only)
    """
    with engine.connect() as conn:
        try:
            logger.info("Starting downgrade of migration 010")
            logger.warning("Downgrading will lose multilingual support and keep English content only!")

            # Step 1: Create temporary TEXT column
            logger.info("Adding temporary column template_content_text...")
            conn.execute(text("""
                ALTER TABLE response_templates
                ADD COLUMN IF NOT EXISTS template_content_text TEXT
            """))
            conn.commit()

            # Step 2: Extract English content from JSON
            logger.info("Extracting English content from JSON...")
            conn.execute(text("""
                UPDATE response_templates
                SET template_content_text = template_content->>'en'
            """))
            conn.commit()

            # Step 3: Drop JSON column and rename text column
            logger.info("Replacing JSON column with TEXT column...")
            conn.execute(text("""
                ALTER TABLE response_templates
                DROP COLUMN template_content
            """))

            conn.execute(text("""
                ALTER TABLE response_templates
                RENAME COLUMN template_content_text TO template_content
            """))

            # Step 4: Add NOT NULL constraint
            conn.execute(text("""
                ALTER TABLE response_templates
                ALTER COLUMN template_content SET NOT NULL
            """))

            conn.commit()
            logger.info("Migration 010 downgrade completed successfully!")

        except Exception as e:
            conn.rollback()
            logger.error(f"Migration 010 downgrade failed: {e}")
            raise

if __name__ == "__main__":
    import sys

    if len(sys.argv) > 1 and sys.argv[1] == "downgrade":
        downgrade()
    else:
        upgrade()
