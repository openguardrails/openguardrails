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
# Format: "Request blocked by OpenGuardrails due to content potentially involving [topic]."
DEFAULT_TEMPLATES = {
    'S1': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving general political topics.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及一般政治话题。"
    },
    'S2': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving sensitive political topics.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及敏感政治话题。"
    },
    'S3': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving insult to national symbols or leaders.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及侮辱国家象征或领导人。"
    },
    'S4': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving harm to minors.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及伤害未成年人。"
    },
    'S5': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving violent crime.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及暴力犯罪。"
    },
    'S6': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving non-violent crime.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及非暴力犯罪。"
    },
    'S7': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving pornography.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及色情内容。"
    },
    'S8': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving hate and discrimination.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及仇恨与歧视。"
    },
    'S9': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving prompt injection attacks.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及提示词注入攻击。"
    },
    'S10': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving profanity.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及辱骂。"
    },
    'S11': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving privacy invasion.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及侵犯个人隐私。"
    },
    'S12': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving commercial violations.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及商业违法违规。"
    },
    'S13': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving intellectual property infringement.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及侵犯知识产权。"
    },
    'S14': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving harassment.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及骚扰。"
    },
    'S15': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving weapons of mass destruction.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及大规模杀伤性武器。"
    },
    'S16': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving self-harm.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及自我伤害。"
    },
    'S17': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving sexual crimes.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及性犯罪。"
    },
    'S18': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving threats.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及威胁。"
    },
    'S19': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving professional financial advice.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及专业金融建议。"
    },
    'S20': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving professional medical advice.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及专业医疗建议。"
    },
    'S21': {
        'en': "Request blocked by OpenGuardrails due to content potentially involving professional legal advice.",
        'zh': "请求已被OpenGuardrails拦截，原因：可能涉及专业法律建议。"
    },
    'default': {
        'en': "Request blocked by OpenGuardrails due to content policy violation.",
        'zh': "请求已被OpenGuardrails拦截，原因：违反内容政策。"
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
