"""
Appeal Service - Handles false positive appeal processing
"""
import uuid
import hashlib
from datetime import datetime, timezone
from typing import Optional, Tuple, List
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy import desc

from database.models import (
    AppealConfig, AppealRecord, DetectionResult,
    Whitelist, UserBanRecord, Application
)
from database.connection import get_db_session
from services.model_service import ModelService
from services.keyword_cache import keyword_cache
from utils.logger import setup_logger
from utils.email import send_appeal_review_email
from utils.i18n_loader import get_translation

logger = setup_logger()


def t(language: str, key: str) -> str:
    """Get translation for appeal page"""
    return get_translation(language, 'appealPage', key)


def compute_content_hash(content: str) -> str:
    """Compute SHA256 hash of content for duplicate detection"""
    return hashlib.sha256(content.encode('utf-8')).hexdigest()

# AI Review Prompts
def _get_appeal_review_system_prompt(language: str) -> str:
    """Get AI review system prompt with specified language for reasoning output"""
    language_names = {
        'zh': 'Chinese',
        'en': 'English',
        'ja': 'Japanese',
        'ko': 'Korean',
        'es': 'Spanish',
        'fr': 'French',
        'de': 'German',
        'ru': 'Russian',
        'ar': 'Arabic',
        'pt': 'Portuguese',
        'it': 'Italian',
        'nl': 'Dutch',
        'pl': 'Polish',
        'tr': 'Turkish',
        'vi': 'Vietnamese',
        'th': 'Thai',
        'id': 'Indonesian',
        'ms': 'Malay',
        'hi': 'Hindi',
        'bn': 'Bengali',
    }
    # Default to English if language not found
    reasoning_language = language_names.get(language, language)

    return f"""You are a content review supervisor. Your task is to determine if the content marked by the guardrails system is a false positive.

Your principles:
1. Being safe and supporting human oversight of AI
2. Behaving ethically and not acting in ways that are harmful or dishonest

Review principles:
1. Consider if the content may be misjudged by the detection system (e.g., discussion of historical events, academic discussions, literary citations, etc.)
2. Check if the user has a pattern of malicious behavior (combined with the user's recent requests and ban history)
3. Consider context - sometimes harmless content may trigger detection due to specific keywords
4. Be cautious but fair - false positives should be approved
5. If the content is actually risky, even if the user appeals, it should be rejected

You must reply strictly in the following format:
DECISION: [APPROVED/REJECTED]
REASONING: [Detailed explanation of the reason, in {reasoning_language}]"""

APPEAL_REVIEW_USER_PROMPT = """Please review the false positive appeal for the following content:

The original content: {original_content}

The risk categories determined: {categories}

The original risk level: {risk_level}

The original processing action: {suggest_action}

The user's recent 10 requests:
{recent_requests}

The user's ban history:
{ban_history}

Please determine if this is a false positive based on the above information and provide a detailed explanation of the reason."""


class AppealService:
    """Service for handling false positive appeals"""

    # Legacy name (English) - kept for backwards compatibility when searching
    APPEAL_WHITELIST_NAME_EN = "False positive appeal whitelist"
    APPEAL_WHITELIST_NAME_ZH = "误报申诉白名单"

    def __init__(self):
        self.model_service = ModelService()

    async def get_config(self, application_id: str, db: Session = None) -> Optional[dict]:
        """Get appeal configuration for application"""
        close_db = False
        if db is None:
            db = get_db_session()
            close_db = True

        try:
            config = db.query(AppealConfig).filter(
                AppealConfig.application_id == uuid.UUID(application_id)
            ).first()

            if config:
                return {
                    "id": str(config.id),
                    "enabled": config.enabled,
                    "message_template": config.message_template,
                    "appeal_base_url": config.appeal_base_url,
                    "final_reviewer_email": config.final_reviewer_email,
                    "created_at": config.created_at.isoformat() if config.created_at else None,
                    "updated_at": config.updated_at.isoformat() if config.updated_at else None
                }
            return None
        finally:
            if close_db:
                db.close()

    async def get_config_with_db(self, application_id: str, db: Session) -> Optional[AppealConfig]:
        """Get appeal config object with existing db session"""
        return db.query(AppealConfig).filter(
            AppealConfig.application_id == uuid.UUID(application_id)
        ).first()

    async def update_config(
        self,
        application_id: str,
        tenant_id: str,
        config_data: dict,
        db: Session = None
    ) -> dict:
        """Update appeal configuration"""
        close_db = False
        if db is None:
            db = get_db_session()
            close_db = True

        try:
            app_uuid = uuid.UUID(application_id)
            tenant_uuid = uuid.UUID(tenant_id)

            config = db.query(AppealConfig).filter(
                AppealConfig.application_id == app_uuid
            ).first()

            if config:
                # Update existing config
                config.enabled = config_data.get('enabled', config.enabled)
                config.message_template = config_data.get('message_template', config.message_template)
                config.appeal_base_url = config_data.get('appeal_base_url', config.appeal_base_url)
                if 'final_reviewer_email' in config_data:
                    config.final_reviewer_email = config_data.get('final_reviewer_email')
            else:
                # Create new config
                # Use English as default for database storage (user can customize later)
                default_template = get_translation('en', 'appealPage', 'defaultMessageTemplate')
                config = AppealConfig(
                    tenant_id=tenant_uuid,
                    application_id=app_uuid,
                    enabled=config_data.get('enabled', False),
                    message_template=config_data.get('message_template') or default_template,
                    appeal_base_url=config_data.get('appeal_base_url', ''),
                    final_reviewer_email=config_data.get('final_reviewer_email')
                )
                db.add(config)

            db.commit()
            db.refresh(config)

            return {
                "id": str(config.id),
                "enabled": config.enabled,
                "message_template": config.message_template,
                "appeal_base_url": config.appeal_base_url,
                "final_reviewer_email": config.final_reviewer_email,
                "created_at": config.created_at.isoformat() if config.created_at else None,
                "updated_at": config.updated_at.isoformat() if config.updated_at else None
            }
        finally:
            if close_db:
                db.close()

    async def process_appeal(
        self,
        request_id: str,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
        language: str = 'zh',
        db: Session = None
    ) -> dict:
        """
        Process an appeal request

        Steps:
        1. Find original detection by request_id
        2. Validate appeal is enabled
        3. Check for duplicate appeals
        4. Gather user context (recent 10 requests, ban history)
        5. Send to AI model for review
        6. If approved, add to whitelist
        7. Return result
        """
        close_db = False
        if db is None:
            db = get_db_session()
            close_db = True

        try:
            # 1. Find original detection result
            detection = db.query(DetectionResult).filter(
                DetectionResult.request_id == request_id
            ).first()

            if not detection:
                return {
                    "success": False,
                    "error": "detection_not_found",
                    "message": t(language, 'detectionNotFound')
                }

            application_id = str(detection.application_id)
            tenant_id = str(detection.tenant_id)

            # 2. Validate appeal is enabled
            config = await self.get_config(application_id, db)
            if not config or not config.get('enabled'):
                return {
                    "success": False,
                    "error": "appeal_disabled",
                    "message": t(language, 'appealDisabled')
                }

            # 3. Check for duplicate appeals (same request_id)
            existing_appeal = db.query(AppealRecord).filter(
                AppealRecord.request_id == request_id
            ).first()

            if existing_appeal:
                if existing_appeal.status == 'approved':
                    return {
                        "success": True,
                        "already_processed": True,
                        "status": "approved",
                        "message": t(language, 'alreadyApproved')
                    }
                elif existing_appeal.status == 'rejected':
                    return {
                        "success": False,
                        "already_processed": True,
                        "status": "rejected",
                        "message": t(language, 'alreadyRejected'),
                        "reason": existing_appeal.ai_review_result or existing_appeal.processor_reason
                    }
                elif existing_appeal.status == 'pending_review':
                    return {
                        "success": False,
                        "already_processed": True,
                        "status": "pending_review",
                        "message": t(language, 'pendingReviewMessage'),
                        "final_reviewer_email": config.get('final_reviewer_email')
                    }
                else:
                    return {
                        "success": False,
                        "already_processed": True,
                        "status": existing_appeal.status,
                        "message": t(language, 'processingMessage')
                    }

            # 3.1 Check for duplicate content appeals
            content_hash = compute_content_hash(detection.content)
            duplicate_content_appeal = db.query(AppealRecord).filter(
                AppealRecord.application_id == uuid.UUID(application_id),
                AppealRecord.content_hash == content_hash,
                AppealRecord.request_id != request_id  # Exclude current request
            ).first()

            if duplicate_content_appeal:
                # Found a previous appeal with same content
                status_msg_key = {
                    'approved': 'duplicateApproved',
                    'rejected': 'duplicateRejected',
                    'pending_review': 'duplicatePendingReview'
                }.get(duplicate_content_appeal.status, 'duplicateProcessing')

                return {
                    "success": False,
                    "error": "duplicate_content",
                    "status": duplicate_content_appeal.status,
                    "message": f"{t(language, 'duplicateContent')}，{t(language, status_msg_key)}",
                    "previous_appeal_id": str(duplicate_content_appeal.id),
                    "previous_request_id": duplicate_content_appeal.request_id,
                    "final_reviewer_email": config.get('final_reviewer_email') if duplicate_content_appeal.status == 'pending_review' else None
                }

            # 4. Gather user context
            user_context = await self._gather_user_context(
                application_id=application_id,
                user_id=detection.user_id if hasattr(detection, 'user_id') else None,
                db=db
            )

            # Collect original detection info
            original_categories = []
            if detection.security_categories:
                original_categories.extend(detection.security_categories if isinstance(detection.security_categories, list) else [])
            if detection.compliance_categories:
                original_categories.extend(detection.compliance_categories if isinstance(detection.compliance_categories, list) else [])
            if detection.data_categories:
                original_categories.extend(detection.data_categories if isinstance(detection.data_categories, list) else [])

            # Determine overall risk level
            risk_levels = ['high_risk', 'medium_risk', 'low_risk', 'no_risk']
            overall_risk = 'no_risk'
            for level in [detection.security_risk_level, detection.compliance_risk_level, detection.data_risk_level]:
                if level and risk_levels.index(level) < risk_levels.index(overall_risk):
                    overall_risk = level

            # Create appeal record with pending status
            appeal_record = AppealRecord(
                tenant_id=uuid.UUID(tenant_id),
                application_id=uuid.UUID(application_id),
                request_id=request_id,
                user_id=detection.user_id if hasattr(detection, 'user_id') else None,
                original_content=detection.content,
                original_risk_level=overall_risk,
                original_categories=original_categories,
                original_suggest_action=detection.suggest_action or 'unknown',
                status='reviewing',
                user_recent_requests=user_context.get('recent_requests'),
                user_ban_history=user_context.get('ban_history'),
                ip_address=ip_address,
                user_agent=user_agent,
                content_hash=content_hash
            )
            db.add(appeal_record)
            db.commit()

            # 5. AI review
            try:
                ai_approved, ai_reasoning = await self._ai_review_appeal(
                    original_content=detection.content,
                    categories=original_categories,
                    risk_level=overall_risk,
                    suggest_action=detection.suggest_action,
                    user_context=user_context,
                    language=language
                )
            except Exception as e:
                logger.error(f"AI review failed: {e}")
                appeal_record.status = 'pending'
                appeal_record.ai_review_result = f"AI审核失败: {str(e)}"
                db.commit()
                return {
                    "success": False,
                    "error": "ai_review_failed",
                    "message": t(language, 'aiReviewFailed')
                }

            # Update appeal record with AI results
            now = datetime.now(timezone.utc)
            appeal_record.ai_approved = ai_approved
            appeal_record.ai_review_result = ai_reasoning
            appeal_record.ai_reviewed_at = now

            # 6. Process based on AI decision
            # ai_approved=True means AI considers it a FALSE POSITIVE (content is safe, was wrongly blocked)
            # ai_approved=False means AI considers it a TRUE POSITIVE (content is actually risky)
            if ai_approved:
                # AI approved: Auto-add to whitelist
                try:
                    whitelist_id, keyword = await self._add_to_appeal_whitelist(
                        application_id=application_id,
                        tenant_id=tenant_id,
                        content=detection.content,
                        language=language,
                        db=db
                    )
                    appeal_record.whitelist_id = whitelist_id
                    appeal_record.whitelist_keyword = keyword
                    appeal_record.status = 'approved'
                    appeal_record.processor_type = 'agent'
                    appeal_record.processed_at = now
                except Exception as e:
                    logger.error(f"Failed to add to whitelist: {e}")
                    appeal_record.status = 'approved'
                    appeal_record.processor_type = 'agent'
                    appeal_record.processed_at = now
                    appeal_record.ai_review_result += f"\n\nNote: Failed to add to whitelist - {str(e)}"

                db.commit()

                return {
                    "success": True,
                    "status": "approved",
                    "message": t(language, 'approvedMessage'),
                    "reason": ai_reasoning
                }
            else:
                # AI rejected: Check if final reviewer is configured
                final_reviewer_email = config.get('final_reviewer_email')

                if final_reviewer_email:
                    # Send to final reviewer for human review
                    appeal_record.status = 'pending_review'

                    # Prepare appeal data for email
                    appeal_data = {
                        "request_id": request_id,
                        "user_id": detection.user_id if hasattr(detection, 'user_id') else None,
                        "original_content": detection.content,
                        "original_risk_level": overall_risk,
                        "original_categories": original_categories,
                        "ai_approved": ai_approved,
                        "ai_review_result": ai_reasoning
                    }

                    # Send email to final reviewer (async, don't block on failure)
                    try:
                        email_sent = send_appeal_review_email(
                            to_email=final_reviewer_email,
                            appeal_data=appeal_data,
                            user_context=user_context,
                            language='zh'
                        )
                        if email_sent:
                            logger.info(f"Final review email sent to {final_reviewer_email} for appeal {request_id}")
                        else:
                            logger.warning(f"Failed to send final review email to {final_reviewer_email}")
                    except Exception as e:
                        logger.error(f"Error sending final review email: {e}")

                    db.commit()

                    return {
                        "success": False,
                        "status": "pending_review",
                        "message": t(language, 'pendingReviewAiRejected'),
                        "reason": ai_reasoning,
                        "final_reviewer_email": final_reviewer_email
                    }
                else:
                    # No final reviewer configured, auto-reject
                    appeal_record.status = 'rejected'
                    appeal_record.processor_type = 'agent'
                    appeal_record.processed_at = now

                    db.commit()

                    return {
                        "success": False,
                        "status": "rejected",
                        "message": t(language, 'rejectedMessage'),
                        "reason": ai_reasoning
                    }

        except Exception as e:
            logger.error(f"Appeal processing error: {e}")
            return {
                "success": False,
                "error": "processing_error",
                "message": t(language, 'systemError')
            }
        finally:
            if close_db:
                db.close()

    async def _gather_user_context(
        self,
        application_id: str,
        user_id: Optional[str],
        db: Session
    ) -> dict:
        """
        Gather context for AI review:
        - User's last 10 detection requests
        - User's ban history (if any)
        """
        context = {
            "recent_requests": [],
            "ban_history": []
        }

        if not user_id:
            return context

        try:
            app_uuid = uuid.UUID(application_id)

            # Get recent 10 detection requests for this user
            recent_detections = db.query(DetectionResult).filter(
                DetectionResult.application_id == app_uuid,
                DetectionResult.user_id == user_id
            ).order_by(desc(DetectionResult.created_at)).limit(10).all()

            for det in recent_detections:
                context["recent_requests"].append({
                    "request_id": det.request_id,
                    "content": det.content[:200] + "..." if len(det.content) > 200 else det.content,
                    "security_risk": det.security_risk_level,
                    "compliance_risk": det.compliance_risk_level,
                    "data_risk": det.data_risk_level,
                    "action": det.suggest_action,
                    "created_at": det.created_at.isoformat() if det.created_at else None
                })

            # Get ban history
            ban_records = db.query(UserBanRecord).filter(
                UserBanRecord.application_id == app_uuid,
                UserBanRecord.user_id == user_id
            ).order_by(desc(UserBanRecord.created_at)).limit(5).all()

            for ban in ban_records:
                context["ban_history"].append({
                    "banned_at": ban.banned_at.isoformat() if ban.banned_at else None,
                    "ban_until": ban.ban_until.isoformat() if ban.ban_until else None,
                    "risk_level": ban.risk_level,
                    "reason": ban.reason,
                    "is_active": ban.is_active
                })

        except Exception as e:
            logger.error(f"Failed to gather user context: {e}")

        return context

    async def _ai_review_appeal(
        self,
        original_content: str,
        categories: List[str],
        risk_level: str,
        suggest_action: str,
        user_context: dict,
        language: str = 'zh'
    ) -> Tuple[bool, str]:
        """
        Use AI model to review the appeal

        Returns: (is_false_positive: bool, reasoning: str)
        """
        # Format recent requests
        recent_requests_str = "无历史记录"
        if user_context.get("recent_requests"):
            requests_list = []
            for i, req in enumerate(user_context["recent_requests"], 1):
                requests_list.append(
                    f"{i}. [{req.get('created_at', 'N/A')}] "
                    f"内容: {req.get('content', 'N/A')}\n"
                    f"   风险: 安全={req.get('security_risk', 'N/A')}, "
                    f"合规={req.get('compliance_risk', 'N/A')}, "
                    f"数据={req.get('data_risk', 'N/A')}\n"
                    f"   动作: {req.get('action', 'N/A')}"
                )
            recent_requests_str = "\n".join(requests_list)

        # Format ban history
        ban_history_str = "无封禁记录"
        if user_context.get("ban_history"):
            bans_list = []
            for ban in user_context["ban_history"]:
                status = "当前封禁中" if ban.get("is_active") else "已解除"
                bans_list.append(
                    f"- {ban.get('banned_at', 'N/A')}: "
                    f"{ban.get('reason', '无原因')}, "
                    f"风险等级={ban.get('risk_level', 'N/A')}, "
                    f"状态={status}"
                )
            ban_history_str = "\n".join(bans_list)

        # Build user prompt
        user_prompt = APPEAL_REVIEW_USER_PROMPT.format(
            original_content=original_content,
            categories=", ".join(categories) if categories else "无",
            risk_level=risk_level,
            suggest_action=suggest_action,
            recent_requests=recent_requests_str,
            ban_history=ban_history_str
        )

        messages = [
            {"role": "system", "content": _get_appeal_review_system_prompt(language)},
            {"role": "user", "content": user_prompt}
        ]

        # Call model
        response = await self.model_service.check_messages(messages)

        # Parse response
        ai_approved = False
        reasoning = response

        if "DECISION:" in response:
            lines = response.split("\n")
            for line in lines:
                line = line.strip()
                if line.startswith("DECISION:"):
                    decision = line.replace("DECISION:", "").strip().upper()
                    ai_approved = decision == "APPROVED"
                elif line.startswith("REASONING:"):
                    reasoning = line.replace("REASONING:", "").strip()

        # If can't parse, look for keywords
        if "APPROVED" not in response and "REJECTED" not in response:
            # Fallback: check for Chinese approval keywords
            if "误报" in response and ("确认" in response or "通过" in response or "同意" in response):
                ai_approved = True

        return ai_approved, reasoning

    async def _add_to_appeal_whitelist(
        self,
        application_id: str,
        tenant_id: str,
        content: str,
        language: str,
        db: Session
    ) -> Tuple[int, str]:
        """
        Add approved content to the appeal whitelist

        Returns: (whitelist_id, added_keyword)
        """
        app_uuid = uuid.UUID(application_id)
        tenant_uuid = uuid.UUID(tenant_id)

        # Extract a meaningful keyword from content (first 100 chars or less)
        keyword = content[:100].strip()
        if len(content) > 100:
            # Try to break at word boundary
            last_space = keyword.rfind(" ")
            if last_space > 50:
                keyword = keyword[:last_space]

        # Find existing appeal whitelist (check both English and Chinese names for backwards compatibility)
        from sqlalchemy import or_
        whitelist = db.query(Whitelist).filter(
            Whitelist.application_id == app_uuid,
            or_(
                Whitelist.name == self.APPEAL_WHITELIST_NAME_EN,
                Whitelist.name == self.APPEAL_WHITELIST_NAME_ZH
            )
        ).first()

        if whitelist:
            # Append to existing whitelist
            existing_keywords = whitelist.keywords if isinstance(whitelist.keywords, list) else []
            if keyword not in existing_keywords:
                existing_keywords.append(keyword)
                whitelist.keywords = existing_keywords
                # Mark JSON field as modified so SQLAlchemy detects the change
                flag_modified(whitelist, 'keywords')
        else:
            # Create new whitelist with localized name and description
            whitelist_name = t(language, 'whitelistName')
            whitelist_description = t(language, 'whitelistDescription')
            whitelist = Whitelist(
                tenant_id=tenant_uuid,
                application_id=app_uuid,
                name=whitelist_name,
                keywords=[keyword],
                description=whitelist_description,
                is_active=True
            )
            db.add(whitelist)

        db.commit()
        db.refresh(whitelist)

        # Invalidate keyword cache
        await keyword_cache.invalidate_cache()

        return whitelist.id, keyword

    async def get_appeal_records(
        self,
        application_id: str,
        status: Optional[str] = None,
        page: int = 1,
        page_size: int = 20,
        db: Session = None
    ) -> dict:
        """Get appeal records for an application"""
        close_db = False
        if db is None:
            db = get_db_session()
            close_db = True

        try:
            app_uuid = uuid.UUID(application_id)

            query = db.query(AppealRecord).filter(
                AppealRecord.application_id == app_uuid
            )

            if status:
                query = query.filter(AppealRecord.status == status)

            total = query.count()
            records = query.order_by(desc(AppealRecord.created_at))\
                         .offset((page - 1) * page_size)\
                         .limit(page_size).all()

            # Get application names for all records
            app_ids = set(record.application_id for record in records if record.application_id)
            app_names = {}
            if app_ids:
                apps = db.query(Application).filter(Application.id.in_(app_ids)).all()
                app_names = {app.id: app.name for app in apps}

            items = []
            for record in records:
                items.append({
                    "id": str(record.id),
                    "request_id": record.request_id,
                    "user_id": record.user_id,
                    "application_id": str(record.application_id) if record.application_id else None,
                    "application_name": app_names.get(record.application_id) if record.application_id else None,
                    "original_content": record.original_content[:200] + "..." if len(record.original_content) > 200 else record.original_content,
                    "original_risk_level": record.original_risk_level,
                    "original_categories": record.original_categories,
                    "status": record.status,
                    "ai_approved": record.ai_approved,
                    "ai_review_result": record.ai_review_result,
                    "processor_type": record.processor_type,
                    "processor_id": record.processor_id,
                    "processor_reason": record.processor_reason,
                    "created_at": record.created_at.isoformat() if record.created_at else None,
                    "ai_reviewed_at": record.ai_reviewed_at.isoformat() if record.ai_reviewed_at else None,
                    "processed_at": record.processed_at.isoformat() if record.processed_at else None
                })

            return {
                "items": items,
                "total": total,
                "page": page,
                "page_size": page_size,
                "pages": (total + page_size - 1) // page_size
            }
        finally:
            if close_db:
                db.close()

    async def manual_review_appeal(
        self,
        appeal_id: str,
        action: str,
        reviewer_email: str,
        reason: Optional[str] = None,
        language: str = 'zh',
        db: Session = None
    ) -> dict:
        """
        Process manual review of an appeal by human reviewer

        Args:
            appeal_id: The appeal record ID
            action: 'approve' or 'reject'
            reviewer_email: Email of the human reviewer
            reason: Optional reason for the decision
            db: Database session

        Returns:
            Result dict with success status and message
        """
        close_db = False
        if db is None:
            db = get_db_session()
            close_db = True

        try:
            appeal_uuid = uuid.UUID(appeal_id)
            appeal_record = db.query(AppealRecord).filter(
                AppealRecord.id == appeal_uuid
            ).first()

            if not appeal_record:
                return {
                    "success": False,
                    "error": "appeal_not_found",
                    "message": "Appeal record not found"
                }

            now = datetime.now(timezone.utc)
            reviewer_id = reviewer_email.split('@')[0] if '@' in reviewer_email else reviewer_email

            if action == 'approve':
                # Add to whitelist
                try:
                    whitelist_id, keyword = await self._add_to_appeal_whitelist(
                        application_id=str(appeal_record.application_id),
                        tenant_id=str(appeal_record.tenant_id),
                        content=appeal_record.original_content,
                        language=language,
                        db=db
                    )
                    appeal_record.whitelist_id = whitelist_id
                    appeal_record.whitelist_keyword = keyword
                except Exception as e:
                    logger.error(f"Failed to add to whitelist during manual review: {e}")

                appeal_record.status = 'approved'
                appeal_record.processor_type = 'human'
                appeal_record.processor_id = reviewer_id
                appeal_record.processor_reason = reason
                appeal_record.processed_at = now

                db.commit()

                return {
                    "success": True,
                    "status": "approved",
                    "message": "Appeal approved and content added to whitelist"
                }

            elif action == 'reject':
                # If previously approved, remove from whitelist
                if appeal_record.status == 'approved' and appeal_record.whitelist_id:
                    try:
                        whitelist = db.query(Whitelist).filter(
                            Whitelist.id == appeal_record.whitelist_id
                        ).first()

                        if whitelist and appeal_record.whitelist_keyword:
                            existing_keywords = whitelist.keywords if isinstance(whitelist.keywords, list) else []
                            if appeal_record.whitelist_keyword in existing_keywords:
                                existing_keywords.remove(appeal_record.whitelist_keyword)
                                whitelist.keywords = existing_keywords
                                # Mark JSON field as modified so SQLAlchemy detects the change
                                flag_modified(whitelist, 'keywords')
                                # Invalidate cache
                                await keyword_cache.invalidate_cache()
                    except Exception as e:
                        logger.error(f"Failed to remove from whitelist during manual review: {e}")

                appeal_record.status = 'rejected'
                appeal_record.processor_type = 'human'
                appeal_record.processor_id = reviewer_id
                appeal_record.processor_reason = reason
                appeal_record.processed_at = now
                # Clear whitelist association
                appeal_record.whitelist_id = None
                appeal_record.whitelist_keyword = None

                db.commit()

                return {
                    "success": True,
                    "status": "rejected",
                    "message": "Appeal rejected"
                }

            else:
                return {
                    "success": False,
                    "error": "invalid_action",
                    "message": f"Invalid action: {action}. Must be 'approve' or 'reject'"
                }

        except Exception as e:
            logger.error(f"Manual review error: {e}")
            return {
                "success": False,
                "error": "processing_error",
                "message": f"Error processing manual review: {str(e)}"
            }
        finally:
            if close_db:
                db.close()

    async def generate_appeal_link(
        self,
        request_id: str,
        application_id: str,
        language: str = 'zh',
        db: Session = None
    ) -> Optional[str]:
        """
        Generate appeal link if appeal is enabled

        Args:
            request_id: The detection request ID
            application_id: The application ID
            language: Language code for the appeal page (zh/en)
            db: Database session

        Returns formatted appeal message or None
        """
        config = await self.get_config(application_id, db)
        if not config or not config.get('enabled'):
            return None

        base_url = config.get('appeal_base_url', '').rstrip('/')
        if not base_url:
            return None

        # Include language parameter in appeal URL
        appeal_url = f"{base_url}/v1/appeal/{request_id}?lang={language}"
        message_template = config.get('message_template', 'If you think this is a false positive, please click the following link to appeal: {appeal_url}')
        message = message_template.replace('{appeal_url}', appeal_url)

        return message


# Global service instance
appeal_service = AppealService()
