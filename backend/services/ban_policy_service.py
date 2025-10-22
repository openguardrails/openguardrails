"""
Ban policy service module
Responsible for managing ban policies, user ban checks and records
"""
from typing import Optional, Dict, Any, List
from datetime import datetime, timedelta, timezone
from sqlalchemy import text
from database.connection import get_admin_db_session
from utils.i18n import format_ban_reason
import logging
import uuid

logger = logging.getLogger(__name__)

def utcnow():
    """Get current UTC time (timezone-aware)"""
    return datetime.now(timezone.utc)


class BanPolicyService:
    """Ban policy service class"""

    @staticmethod
    async def get_ban_policy(tenant_id: str) -> Optional[Dict[str, Any]]:
        """Get tenant's ban policy configuration"""
        db = get_admin_db_session()
        try:
            result = db.execute(
                text("""
                SELECT id, tenant_id, enabled, risk_level, trigger_count,
                       time_window_minutes, ban_duration_minutes,
                       created_at, updated_at
                FROM ban_policies
                WHERE tenant_id = :tenant_id
                """),
                {"tenant_id": tenant_id}
            )
            row = result.fetchone()
            if row:
                return {
                    'id': str(row[0]),
                    'tenant_id': str(row[1]),
                    'enabled': row[2],
                    'risk_level': row[3],
                    'trigger_count': row[4],
                    'time_window_minutes': row[5],
                    'ban_duration_minutes': row[6],
                    'created_at': row[7],
                    'updated_at': row[8]
                }
            return None
        finally:
            db.close()

    @staticmethod
    async def update_ban_policy(tenant_id: str, policy_data: Dict[str, Any]) -> Dict[str, Any]:
        """Update ban policy configuration"""
        db = get_admin_db_session()
        try:
            # Check if policy exists
            result = db.execute(
                text("SELECT id FROM ban_policies WHERE tenant_id = :tenant_id"),
                {"tenant_id": tenant_id}
            )
            existing = result.fetchone()

            if existing:
                # Update existing policy
                result = db.execute(
                    text("""
                    UPDATE ban_policies
                    SET enabled = :enabled,
                        risk_level = :risk_level,
                        trigger_count = :trigger_count,
                        time_window_minutes = :time_window_minutes,
                        ban_duration_minutes = :ban_duration_minutes,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE tenant_id = :tenant_id
                    RETURNING id, tenant_id, enabled, risk_level, trigger_count,
                              time_window_minutes, ban_duration_minutes,
                              created_at, updated_at
                    """),
                    {
                        "tenant_id": tenant_id,
                        "enabled": policy_data.get('enabled', False),
                        "risk_level": policy_data.get('risk_level', 'high_risk'),
                        "trigger_count": policy_data.get('trigger_count', 3),
                        "time_window_minutes": policy_data.get('time_window_minutes', 10),
                        "ban_duration_minutes": policy_data.get('ban_duration_minutes', 60)
                    }
                )
                db.commit()
            else:
                # Create new policy
                result = db.execute(
                    text("""
                    INSERT INTO ban_policies (tenant_id, enabled, risk_level, trigger_count,
                                             time_window_minutes, ban_duration_minutes)
                    VALUES (:tenant_id, :enabled, :risk_level, :trigger_count,
                            :time_window_minutes, :ban_duration_minutes)
                    RETURNING id, tenant_id, enabled, risk_level, trigger_count,
                              time_window_minutes, ban_duration_minutes,
                              created_at, updated_at
                    """),
                    {
                        "tenant_id": tenant_id,
                        "enabled": policy_data.get('enabled', False),
                        "risk_level": policy_data.get('risk_level', 'high_risk'),
                        "trigger_count": policy_data.get('trigger_count', 3),
                        "time_window_minutes": policy_data.get('time_window_minutes', 10),
                        "ban_duration_minutes": policy_data.get('ban_duration_minutes', 60)
                    }
                )
                db.commit()

            row = result.fetchone()
            return {
                'id': str(row[0]),
                'tenant_id': str(row[1]),
                'enabled': row[2],
                'risk_level': row[3],
                'trigger_count': row[4],
                'time_window_minutes': row[5],
                'ban_duration_minutes': row[6],
                'created_at': row[7],
                'updated_at': row[8]
            }
        except Exception as e:
            db.rollback()
            raise e
        finally:
            db.close()

    @staticmethod
    async def check_user_banned(tenant_id: str, user_id: str) -> Optional[Dict[str, Any]]:
        """Check if user is banned"""
        db = get_admin_db_session()
        try:
            result = db.execute(
                text("""
                SELECT id, user_id, banned_at, ban_until, trigger_count,
                       risk_level, reason
                FROM user_ban_records
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND is_active = true
                  AND ban_until > CURRENT_TIMESTAMP
                ORDER BY banned_at DESC
                LIMIT 1
                """),
                {"tenant_id": tenant_id, "user_id": user_id}
            )
            row = result.fetchone()
            if row:
                return {
                    'id': str(row[0]),
                    'user_id': row[1],
                    'banned_at': row[2],
                    'ban_until': row[3],
                    'trigger_count': row[4],
                    'risk_level': row[5],
                    'reason': row[6]
                }
            return None
        finally:
            db.close()

    @staticmethod
    async def check_and_apply_ban_policy(
        tenant_id: str,
        user_id: str,
        risk_level: str,
        detection_result_id: Optional[str] = None,
        language: str = 'zh'
    ) -> Optional[Dict[str, Any]]:
        """Check and apply ban policy"""
        logger.info(f"check_and_apply_ban_policy called: tenant_id={tenant_id}, user_id={user_id}, risk_level={risk_level}")
        db = get_admin_db_session()
        try:
            # Get ban policy
            logger.info(f"Fetching ban policy for tenant_id={tenant_id}")
            policy_result = db.execute(
                text("""
                SELECT enabled, risk_level, trigger_count, time_window_minutes, ban_duration_minutes
                FROM ban_policies
                WHERE tenant_id = :tenant_id
                """),
                {"tenant_id": tenant_id}
            )
            policy = policy_result.fetchone()
            logger.info(f"Ban policy fetched: {policy}")

            # If policy not exists or not enabled, return directly
            if not policy or not policy[0]:  # enabled
                logger.info(f"Ban policy not found or disabled for tenant_id={tenant_id}")
                return None

            policy_risk_level = policy[1]
            trigger_count = policy[2]
            time_window_minutes = policy[3]
            ban_duration_minutes = policy[4]
            logger.info(f"Policy config: risk_level={policy_risk_level}, trigger_count={trigger_count}, window={time_window_minutes}min, duration={ban_duration_minutes}min")

            # Risk level mapping
            risk_level_map = {'low_risk': 1, 'medium_risk': 2, 'high_risk': 3}
            current_risk_value = risk_level_map.get(risk_level, 0)
            policy_risk_value = risk_level_map.get(policy_risk_level, 3)
            logger.info(f"Risk level check: current={risk_level}({current_risk_value}), policy={policy_risk_level}({policy_risk_value})")

            # If current risk level is below policy required level, not record
            if current_risk_value < policy_risk_value:
                logger.info(f"Risk level below policy threshold, skipping")
                return None

            # Record risk trigger
            logger.info(f"Recording risk trigger for user_id={user_id}")
            db.execute(
                text("""
                INSERT INTO user_risk_triggers (tenant_id, user_id, detection_result_id, risk_level, triggered_at)
                VALUES (:tenant_id, :user_id, :detection_result_id, :risk_level, CURRENT_TIMESTAMP)
                """),
                {
                    "tenant_id": tenant_id,
                    "user_id": user_id,
                    "detection_result_id": detection_result_id,
                    "risk_level": risk_level
                }
            )
            db.commit()
            logger.info(f"Risk trigger recorded successfully")

            # Calculate window start
            window_start = utcnow() - timedelta(minutes=time_window_minutes)
            logger.info(f"Checking triggers since {window_start}")

            # Count triggers in window
            count_result = db.execute(
                text("""
                SELECT COUNT(*) FROM user_risk_triggers
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND risk_level = :risk_level
                  AND triggered_at > :window_start
                """),
                {
                    "tenant_id": tenant_id,
                    "user_id": user_id,
                    "risk_level": policy_risk_level,
                    "window_start": window_start
                }
            )
            trigger_count_actual = count_result.scalar()
            logger.info(f"Trigger count in window: {trigger_count_actual}/{trigger_count}")

            # If threshold reached, create ban record
            if trigger_count_actual >= trigger_count:
                logger.info(f"Trigger count threshold reached, creating ban record")
                # Check if there is an active ban record
                existing_result = db.execute(
                    text("""
                    SELECT id FROM user_ban_records
                    WHERE tenant_id = :tenant_id
                      AND user_id = :user_id
                      AND is_active = true
                      AND ban_until > CURRENT_TIMESTAMP
                    """),
                    {"tenant_id": tenant_id, "user_id": user_id}
                )
                existing_ban = existing_result.fetchone()

                if not existing_ban:
                    logger.info(f"No existing ban found, creating new ban record")
                    # Create new ban record
                    ban_until = utcnow() + timedelta(minutes=ban_duration_minutes)
                    reason = format_ban_reason(
                        time_window=time_window_minutes,
                        trigger_count=trigger_count_actual,
                        risk_level=policy_risk_level,
                        language=language
                    )

                    result = db.execute(
                        text("""
                        INSERT INTO user_ban_records (
                            tenant_id, user_id, banned_at, ban_until,
                            trigger_count, risk_level, reason, is_active
                        )
                        VALUES (
                            :tenant_id, :user_id, CURRENT_TIMESTAMP, :ban_until,
                            :trigger_count, :risk_level, :reason, true
                        )
                        RETURNING id, user_id, banned_at, ban_until, trigger_count, risk_level, reason
                        """),
                        {
                            "tenant_id": tenant_id,
                            "user_id": user_id,
                            "ban_until": ban_until,
                            "trigger_count": trigger_count_actual,
                            "risk_level": policy_risk_level,
                            "reason": reason
                        }
                    )
                    db.commit()

                    row = result.fetchone()
                    logger.warning(f"User {user_id} has been banned until {ban_until}, reason: {reason}")

                    return {
                        'id': str(row[0]),
                        'user_id': row[1],
                        'banned_at': row[2],
                        'ban_until': row[3],
                        'trigger_count': row[4],
                        'risk_level': row[5],
                        'reason': row[6]
                    }
                else:
                    logger.info(f"User already has active ban, skipping")
            else:
                logger.info(f"Trigger count below threshold, not banning")

            return None

        except Exception as e:
            logger.error(f"Error in check_and_apply_ban_policy: {e}", exc_info=True)
            db.rollback()
            logger.error(f"应用封禁策略失败: {e}")
            raise e
        finally:
            db.close()

    @staticmethod
    async def get_banned_users(tenant_id: str, skip: int = 0, limit: int = 100) -> List[Dict[str, Any]]:
        """Get banned users list"""
        db = get_admin_db_session()
        try:
            result = db.execute(
                text("""
                SELECT id, user_id, banned_at, ban_until, trigger_count,
                       risk_level, reason, is_active,
                       CASE
                           WHEN ban_until > CURRENT_TIMESTAMP THEN 'banned'
                           ELSE 'unbanned'
                       END as status
                FROM user_ban_records
                WHERE tenant_id = :tenant_id
                ORDER BY banned_at DESC
                LIMIT :limit OFFSET :skip
                """),
                {"tenant_id": tenant_id, "skip": skip, "limit": limit}
            )

            users = []
            for row in result.fetchall():
                users.append({
                    'id': str(row[0]),
                    'user_id': row[1],
                    'banned_at': row[2],
                    'ban_until': row[3],
                    'trigger_count': row[4],
                    'risk_level': row[5],
                    'reason': row[6],
                    'is_active': row[7],
                    'status': row[8]
                })

            return users
        finally:
            db.close()

    @staticmethod
    async def unban_user(tenant_id: str, user_id: str) -> bool:
        """Manual unban user"""
        db = get_admin_db_session()
        try:
            result = db.execute(
                text("""
                UPDATE user_ban_records
                SET is_active = false, ban_until = CURRENT_TIMESTAMP
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND is_active = true
                """),
                {"tenant_id": tenant_id, "user_id": user_id}
            )
            db.commit()

            affected_rows = result.rowcount
            if affected_rows > 0:
                logger.info(f"User {user_id} has been manually unbanned")
                return True
            return False

        except Exception as e:
            db.rollback()
            logger.error(f"Failed to unban user: {e}")
            raise e
        finally:
            db.close()

    @staticmethod
    async def get_user_risk_history(
        tenant_id: str,
        user_id: str,
        days: int = 7
    ) -> List[Dict[str, Any]]:
        """Get user risk trigger history"""
        db = get_admin_db_session()
        try:
            since = utcnow() - timedelta(days=days)

            result = db.execute(
                text("""
                SELECT id, detection_result_id, risk_level, triggered_at
                FROM user_risk_triggers
                WHERE tenant_id = :tenant_id
                  AND user_id = :user_id
                  AND triggered_at > :since
                ORDER BY triggered_at DESC
                """),
                {"tenant_id": tenant_id, "user_id": user_id, "since": since}
            )

            history = []
            for row in result.fetchall():
                history.append({
                    'id': str(row[0]),
                    'detection_result_id': str(row[1]) if row[1] else None,
                    'risk_level': row[2],
                    'triggered_at': row[3]
                })

            return history
        finally:
            db.close()
