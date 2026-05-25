import time
import asyncio
from typing import Dict, Optional
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from sqlalchemy import text, select, update, and_
from database.models import TenantRateLimit, TenantRateLimitCounter, Tenant
from services.redis_client import get_redis, k as redis_k
from utils.logger import setup_logger

logger = setup_logger()

# Lua script: atomic INCR + EXPIRE in a fixed 1-second window. Returns 1
# if the request is allowed, 0 if it would exceed the limit. Loaded
# lazily and re-loaded on NOSCRIPT errors (Redis flushed its script
# cache).
_RATE_LIMIT_SCRIPT = """
local current = redis.call('INCR', KEYS[1])
if current == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if current > tonumber(ARGV[1]) then
    return 0
end
return 1
"""


class PostgreSQLRateLimiter:
    """Cross-process rate limiter.

    Phase 2: when Redis is configured (REDIS_URL set), the per-second
    counter lives in Redis (atomic Lua script — single round-trip per
    request). Otherwise the legacy PostgreSQL `tenant_rate_limit_counters`
    path is used. Either way, the public interface (`is_allowed`) is
    unchanged so callers don't have to know which backend is active.

    Class name retained for backward compatibility with imports across
    the codebase (`from services.rate_limiter import PostgreSQLRateLimiter`).
    """

    def __init__(self):
        # Tenant rate limits config cache: {tenant_id: requests_per_second}.
        # Loaded from PG every _cache_ttl seconds; admin updates trigger
        # an explicit invalidation via clear_user_cache().
        self._rate_limits: Dict[str, int] = {}
        # Local cache of tenant current count (PG fallback path only;
        # Redis path doesn't need it because Redis is fast enough).
        self._local_cache: Dict[str, tuple] = {}
        self._cache_update_time = 0
        self._cache_ttl = 30
        self._local_cache_ttl = 0.5
        self._lock = asyncio.Lock()
        # Cached SHA of the loaded Lua script (avoids resending the
        # source on every request once Redis has it cached).
        self._script_sha: Optional[str] = None

    async def is_allowed(self, tenant_id: str, db: Session) -> bool:
        """Check whether tenant is allowed to make this request."""
        try:
            await self._update_config_cache_if_needed(db)

            rate_limit = self._rate_limits.get(tenant_id, 10)

            if rate_limit == 0:
                return True

            # Prefer Redis when available — it's the new home for the
            # hot counter.
            client = await get_redis()
            if client is not None:
                return await self._redis_rate_limit_check(client, tenant_id, rate_limit)

            # Fallback: legacy PG counter path.
            return await self._db_rate_limit_check(tenant_id, rate_limit, db)

        except Exception as e:
            logger.error(f"Rate limit check failed for tenant {tenant_id}: {e}")
            # Fail open: don't block the service when the limiter itself misbehaves.
            return True

    async def _redis_rate_limit_check(self, client, tenant_id: str, rate_limit: int) -> bool:
        """Atomic INCR-and-check inside a 1-second window via Lua.

        One Redis round-trip per request. The Lua script EXPIREs the key
        only on first INCR of the window, so memory stays bounded
        regardless of tenant churn.
        """
        key = redis_k(f"rl:rps:{tenant_id}")
        try:
            # Cache the script SHA across calls; reload on NOSCRIPT.
            # redis-py returns the SHA as a str regardless of
            # `decode_responses`, so don't call `.decode()` on it.
            if self._script_sha is None:
                self._script_sha = await client.script_load(_RATE_LIMIT_SCRIPT)
            try:
                allowed = await client.evalsha(self._script_sha, 1, key, rate_limit, 1)
            except Exception as e:
                # Likely NOSCRIPT after a Redis restart. Re-load and retry.
                msg = str(e)
                if "NOSCRIPT" in msg:
                    self._script_sha = await client.script_load(_RATE_LIMIT_SCRIPT)
                    allowed = await client.evalsha(self._script_sha, 1, key, rate_limit, 1)
                else:
                    raise

            if int(allowed) == 1:
                return True
            logger.warning(f"Rate limit exceeded for tenant {tenant_id} (limit={rate_limit}/s)")
            return False
        except Exception as e:
            logger.warning(f"Redis rate limit check failed for tenant {tenant_id}, failing open: {e}")
            # Don't drop traffic on a Redis blip.
            return True

    async def _db_rate_limit_check(self, tenant_id: str, rate_limit: int, db: Session) -> bool:
        """Database atomic rate limit check and update"""
        try:
            from uuid import UUID
            tenant_uuid = UUID(tenant_id)
            current_time = datetime.now()

            # Use database atomic operation for rate limit check and update
            result = db.execute(text("""
                INSERT INTO tenant_rate_limit_counters (tenant_id, current_count, window_start, last_updated)
                VALUES (:tenant_id, 1, :current_time, :current_time)
                ON CONFLICT (tenant_id) DO UPDATE SET
                    current_count = CASE
                        WHEN tenant_rate_limit_counters.window_start < :current_time - INTERVAL '1 second'
                        THEN 1
                        ELSE tenant_rate_limit_counters.current_count + 1
                    END,
                    window_start = CASE
                        WHEN tenant_rate_limit_counters.window_start < :current_time - INTERVAL '1 second'
                        THEN :current_time
                        ELSE tenant_rate_limit_counters.window_start
                    END,
                    last_updated = :current_time
                WHERE tenant_rate_limit_counters.current_count < :rate_limit
                   OR tenant_rate_limit_counters.window_start < :current_time - INTERVAL '1 second'
                RETURNING current_count, window_start
            """), {
                "tenant_id": tenant_uuid,
                "current_time": current_time,
                "rate_limit": rate_limit
            })

            row = result.fetchone()

            if row:
                # Request allowed, update local cache
                self._local_cache[tenant_id] = (row[0], time.time())
                logger.debug(f"Rate limit allowed for tenant {tenant_id}: {row[0]}/{rate_limit}")
                db.commit()
                return True
            else:
                # Request limited
                # Get current count for logging
                counter_result = db.execute(text("""
                    SELECT current_count FROM tenant_rate_limit_counters WHERE tenant_id = :tenant_id
                """), {"tenant_id": tenant_uuid})
                counter_row = counter_result.fetchone()
                current_count = counter_row[0] if counter_row else 0

                logger.warning(f"Rate limit exceeded for tenant {tenant_id}: {current_count}/{rate_limit}")
                db.rollback()
                return False

        except Exception as e:
            logger.error(f"Database rate limit check failed for tenant {tenant_id}: {e}")
            db.rollback()
            # Allow through when database error occurs
            return True
    
    async def _update_config_cache_if_needed(self, db: Session):
        """Update configuration cache if needed"""
        current_time = time.time()
        if current_time - self._cache_update_time > self._cache_ttl:
            try:
                # Query all enabled tenant rate limit configurations
                rate_limits = db.query(TenantRateLimit).filter(TenantRateLimit.is_active == True).all()

                # Update cache
                new_limits = {}
                for limit in rate_limits:
                    new_limits[str(limit.tenant_id)] = limit.requests_per_second

                self._rate_limits = new_limits
                self._cache_update_time = current_time

                logger.debug(f"Rate limit config cache updated with {len(new_limits)} entries")

            except Exception as e:
                logger.error(f"Failed to update rate limit config cache: {e}")
    
    def clear_user_cache(self, tenant_id: str):
        """Clear cache for specified tenant

        Note: For backward compatibility, function name remains clear_user_cache, parameter name remains tenant_id, but tenant_id is actually processed
        """
        tenant_id = tenant_id  # For backward compatibility, internally use tenant_id
        # Clear local cache
        if tenant_id in self._local_cache:
            del self._local_cache[tenant_id]

        # Force next update configuration cache
        self._cache_update_time = 0

# Global rate limiter instance
rate_limiter = PostgreSQLRateLimiter()

class RateLimitService:
    """Rate limit service"""

    def __init__(self, db: Session):
        self.db = db

    def check_and_increment_monthly_usage(self, tenant_id: str) -> tuple[bool, Optional[int], Optional[int]]:
        """Check monthly scan limit and increment usage counter

        Args:
            tenant_id: Tenant UUID string

        Returns:
            tuple: (is_allowed, current_usage, monthly_limit)
                - is_allowed: True if request is allowed, False if limit exceeded
                - current_usage: Current month usage count (None if no limit configured)
                - monthly_limit: Monthly limit (None if no limit configured or unlimited)
        """
        try:
            from uuid import UUID
            from dateutil.relativedelta import relativedelta
            tenant_uuid = UUID(tenant_id)
            current_time = datetime.now()

            # Get rate limit config
            rate_limit_config = self.db.query(TenantRateLimit).filter(
                TenantRateLimit.tenant_id == tenant_uuid,
                TenantRateLimit.is_active == True
            ).first()

            if not rate_limit_config:
                # No config found, allow by default
                return True, None, None

            # Check if monthly limit is set (0 means unlimited)
            if rate_limit_config.monthly_scan_limit == 0:
                return True, None, 0

            # Check if we need to reset the counter (new month)
            if rate_limit_config.usage_reset_at:
                # Calculate the start of current month
                current_month_start = current_time.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
                reset_month_start = rate_limit_config.usage_reset_at.replace(day=1, hour=0, minute=0, second=0, microsecond=0)

                if current_month_start > reset_month_start:
                    # New month, reset counter
                    rate_limit_config.current_month_usage = 0
                    rate_limit_config.usage_reset_at = current_time

            # Check if limit exceeded
            if rate_limit_config.current_month_usage >= rate_limit_config.monthly_scan_limit:
                self.db.commit()  # Commit the reset if it happened
                logger.warning(f"Monthly scan limit exceeded for tenant {tenant_id}: {rate_limit_config.current_month_usage}/{rate_limit_config.monthly_scan_limit}")
                return False, rate_limit_config.current_month_usage, rate_limit_config.monthly_scan_limit

            # Increment counter
            rate_limit_config.current_month_usage += 1
            rate_limit_config.updated_at = current_time
            self.db.commit()

            logger.debug(f"Monthly usage incremented for tenant {tenant_id}: {rate_limit_config.current_month_usage}/{rate_limit_config.monthly_scan_limit}")
            return True, rate_limit_config.current_month_usage, rate_limit_config.monthly_scan_limit

        except Exception as e:
            self.db.rollback()
            logger.error(f"Failed to check monthly scan limit for tenant {tenant_id}: {e}")
            # Allow through on error to avoid blocking service
            return True, None, None

    @staticmethod
    async def check_and_increment_monthly_usage_async(
        db, tenant_id: str
    ) -> "tuple[bool, Optional[int], Optional[int]]":
        """Async variant of check_and_increment_monthly_usage.

        Phase 3: callers on async routes should use this so the per-request
        monthly quota check stops blocking the event loop. Same semantics
        as the sync version: returns (is_allowed, current_usage,
        monthly_limit). `db` must be an AsyncSession.

        Implemented as a staticmethod so callers don't have to construct
        a RateLimitService(db) wrapper just for this one call — the only
        state RateLimitService holds is the session itself.
        """
        from uuid import UUID
        from sqlalchemy import select

        try:
            tenant_uuid = UUID(tenant_id)
            current_time = datetime.now()

            res = await db.execute(
                select(TenantRateLimit).where(
                    TenantRateLimit.tenant_id == tenant_uuid,
                    TenantRateLimit.is_active == True,  # noqa: E712 — SQL truthiness
                )
            )
            cfg = res.scalar_one_or_none()
            if cfg is None:
                return True, None, None

            # 0 means unlimited
            if cfg.monthly_scan_limit == 0:
                return True, None, 0

            # Reset counter on month boundary
            if cfg.usage_reset_at:
                current_month_start = current_time.replace(
                    day=1, hour=0, minute=0, second=0, microsecond=0
                )
                reset_month_start = cfg.usage_reset_at.replace(
                    day=1, hour=0, minute=0, second=0, microsecond=0
                )
                if current_month_start > reset_month_start:
                    cfg.current_month_usage = 0
                    cfg.usage_reset_at = current_time

            if cfg.current_month_usage >= cfg.monthly_scan_limit:
                # Commit any reset that happened so we don't roll it back.
                await db.commit()
                logger.warning(
                    f"Monthly scan limit exceeded for tenant {tenant_id}: "
                    f"{cfg.current_month_usage}/{cfg.monthly_scan_limit}"
                )
                return False, cfg.current_month_usage, cfg.monthly_scan_limit

            cfg.current_month_usage += 1
            cfg.updated_at = current_time
            await db.commit()

            logger.debug(
                f"Monthly usage incremented for tenant {tenant_id}: "
                f"{cfg.current_month_usage}/{cfg.monthly_scan_limit}"
            )
            return True, cfg.current_month_usage, cfg.monthly_scan_limit

        except Exception as e:
            await db.rollback()
            logger.error(f"Failed to check monthly scan limit for tenant {tenant_id}: {e}")
            # Fail open so the limiter itself can't take down the service.
            return True, None, None

    def get_user_rate_limit(self, tenant_id: str) -> Optional[TenantRateLimit]:
        """Get tenant rate limit configuration

        Note: For backward compatibility, function name remains get_user_rate_limit, parameter name remains tenant_id, but tenant_id is actually processed
        """
        tenant_id = tenant_id  # For backward compatibility, internally use tenant_id
        try:
            from uuid import UUID
            tenant_uuid = UUID(tenant_id)
            return self.db.query(TenantRateLimit).filter(TenantRateLimit.tenant_id == tenant_uuid).first()
        except Exception as e:
            logger.error(f"Failed to get tenant rate limit for {tenant_id}: {e}")
            return None
    
    def set_user_rate_limit(self, tenant_id: str, requests_per_second: int, monthly_scan_limit: int = None) -> TenantRateLimit:
        """Set tenant rate limit

        Note: For backward compatibility, function name remains set_user_rate_limit, parameter name remains tenant_id, but tenant_id is actually processed

        Args:
            tenant_id: Tenant UUID string
            requests_per_second: Requests per second limit
            monthly_scan_limit: Monthly scan limit (optional, uses config default if not provided)
        """
        tenant_id = tenant_id  # For backward compatibility, internally use tenant_id
        try:
            from uuid import UUID
            from config import settings
            tenant_uuid = UUID(tenant_id)

            # Use config default if monthly_scan_limit not provided
            if monthly_scan_limit is None:
                # Use default_monthly_scan_limit if set, otherwise use free_user_monthly_quota
                monthly_scan_limit = settings.default_monthly_scan_limit
                if monthly_scan_limit is None:
                    monthly_scan_limit = settings.free_user_monthly_quota

            # Check if tenant exists
            tenant = self.db.query(Tenant).filter(Tenant.id == tenant_uuid).first()
            if not tenant:
                raise ValueError(f"Tenant {tenant_id} not found")

            # Find existing configuration
            rate_limit_config = self.db.query(TenantRateLimit).filter(TenantRateLimit.tenant_id == tenant_uuid).first()

            if rate_limit_config:
            # Update existing configuration
                rate_limit_config.requests_per_second = requests_per_second
                rate_limit_config.monthly_scan_limit = monthly_scan_limit
                rate_limit_config.is_active = True
                rate_limit_config.updated_at = datetime.now()
            else:
                # Create new configuration
                rate_limit_config = TenantRateLimit(
                    tenant_id=tenant_uuid,
                    requests_per_second=requests_per_second,
                    monthly_scan_limit=monthly_scan_limit,
                    current_month_usage=0,
                    usage_reset_at=datetime.now(),
                    is_active=True
                )
                self.db.add(rate_limit_config)

            self.db.commit()

            # Clear tenant cache, force reload
            rate_limiter.clear_user_cache(tenant_id)

            logger.info(f"Set rate limit for tenant {tenant_id}: {requests_per_second} rps, {monthly_scan_limit} monthly scans")
            return rate_limit_config

        except Exception as e:
            self.db.rollback()
            logger.error(f"Failed to set tenant rate limit for {tenant_id}: {e}")
            raise
    
    def disable_user_rate_limit(self, tenant_id: str):
        """Disable tenant rate limit

        Note: For backward compatibility, function name remains disable_user_rate_limit, parameter name remains tenant_id, but tenant_id is actually processed
        """
        tenant_id = tenant_id  # For backward compatibility, internally use tenant_id
        try:
            from uuid import UUID
            tenant_uuid = UUID(tenant_id)

            rate_limit_config = self.db.query(TenantRateLimit).filter(TenantRateLimit.tenant_id == tenant_uuid).first()
            if rate_limit_config:
                rate_limit_config.is_active = False
                rate_limit_config.updated_at = datetime.now()
                self.db.commit()

                # Clear tenant cache
                rate_limiter.clear_user_cache(tenant_id)

                logger.info(f"Disabled rate limit for tenant {tenant_id}")

        except Exception as e:
            self.db.rollback()
            logger.error(f"Failed to disable tenant rate limit for {tenant_id}: {e}")
            raise
    
    def list_user_rate_limits(self, skip: int = 0, limit: int = 100, search: str = None, 
                              sort_by: str = 'requests_per_second', sort_order: str = 'desc'):
        """List all tenants with their rate limit configurations (including tenants without configurations)

        Note: For backward compatibility, function name remains list_user_rate_limits
        Args:
            skip: Number of records to skip for pagination
            limit: Maximum number of records to return
            search: Search string to filter by tenant email
            sort_by: Field to sort by ('requests_per_second' or 'email')
            sort_order: Sort order ('asc' or 'desc')
        """
        # Query all tenants with LEFT JOIN to rate limits
        # Only include tenant-level rate limits (application_id IS NULL) or tenants without rate limits
        # This ensures each tenant appears only once
        query = (
            self.db.query(Tenant, TenantRateLimit)
            .outerjoin(
                TenantRateLimit, 
                and_(
                    TenantRateLimit.tenant_id == Tenant.id,
                    TenantRateLimit.is_active == True,
                    TenantRateLimit.application_id.is_(None)  # Only tenant-level rate limits
                )
            )
        )
        
        # Add search filter if provided
        if search:
            query = query.filter(Tenant.email.ilike(f'%{search}%'))
        
        # Get total count before pagination
        total = query.count()
        
        # Apply sorting
        if sort_by == 'requests_per_second':
            # For sorting by rate limit, we need to handle NULL values (tenants without configs)
            # Default to 1 RPS for tenants without configurations
            if sort_order.lower() == 'asc':
                query = query.order_by(
                    TenantRateLimit.requests_per_second.asc().nullsfirst(),
                    Tenant.email.asc()
                )
            else:
                query = query.order_by(
                    TenantRateLimit.requests_per_second.desc().nullslast(),
                    Tenant.email.asc()
                )
        elif sort_by == 'email':
            if sort_order.lower() == 'asc':
                query = query.order_by(Tenant.email.asc())
            else:
                query = query.order_by(Tenant.email.desc())
        else:
            # Default: sort by rate limit descending
            query = query.order_by(
                TenantRateLimit.requests_per_second.desc().nullslast(),
                Tenant.email.asc()
            )
        
        # Apply pagination
        results = query.offset(skip).limit(limit).all()
        
        return results, total