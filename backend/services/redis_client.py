"""
Redis client for OpenGuardrails (Phase 2).

Single async connection pool shared across the worker process. Modules
that need Redis import `get_redis()` and check `is_redis_enabled()`; when
REDIS_URL is unset the helpers return None and callers fall back to the
legacy PG-only path. This keeps the cutover safe for existing
deployments that haven't provisioned Redis yet.
"""

from __future__ import annotations

import asyncio
from typing import Optional

from config import settings
from utils.logger import setup_logger

logger = setup_logger()

# We import redis.asyncio lazily so that the backend can still import this
# module on environments that don't have the redis package installed yet
# (e.g., during the brief window after pulling new code but before
# installing requirements). Without lazy import, every entry point would
# crash at import time.
try:
    import redis.asyncio as aioredis  # type: ignore
    _redis_lib_available = True
except ImportError:  # pragma: no cover — exercised only on partial deploys
    aioredis = None  # type: ignore
    _redis_lib_available = False


_client: Optional["aioredis.Redis"] = None
_client_lock = asyncio.Lock()
_init_logged = False


def is_redis_configured() -> bool:
    """True iff REDIS_URL is set. Does not check connectivity."""
    return bool(settings.redis_url)


def is_redis_enabled() -> bool:
    """True iff Redis is configured AND the redis package is importable.

    Callers use this for fast pre-checks before constructing keys/scripts;
    the actual connection failure is handled inside get_redis().
    """
    return is_redis_configured() and _redis_lib_available


async def get_redis() -> Optional["aioredis.Redis"]:
    """Return the shared async Redis client, or None if unconfigured/unavailable.

    The client is created lazily on first call. We do NOT pre-warm at
    process start — keeping the cold-start path off the import critical
    path is important for fast worker boot.
    """
    global _client, _init_logged

    if not is_redis_enabled():
        return None

    if _client is not None:
        return _client

    async with _client_lock:
        # Double-checked: another coroutine may have populated _client
        # while we were waiting on the lock.
        if _client is not None:
            return _client

        try:
            password = settings.redis_password or None
            client = aioredis.from_url(
                settings.redis_url,
                password=password,
                max_connections=settings.redis_pool_size,
                socket_timeout=settings.redis_socket_timeout,
                socket_connect_timeout=settings.redis_socket_timeout,
                # Bytes-in / bytes-out keeps Lua script returns predictable
                # across redis-py versions; callers decode explicitly.
                decode_responses=False,
                health_check_interval=30,
            )
            # Verify reachable; if PING fails we leave _client None so the
            # next call retries (transient DNS/network blips shouldn't
            # permanently disable Redis for this worker).
            await client.ping()
            _client = client
            if not _init_logged:
                logger.info(
                    "Redis client initialized: url=%s pool=%d",
                    _redact_url(settings.redis_url),
                    settings.redis_pool_size,
                )
                _init_logged = True
            return _client
        except Exception as e:
            # Avoid log spam: only the first failure per worker is INFO,
            # subsequent ones DEBUG. The caller decides how to degrade.
            if not _init_logged:
                logger.warning("Redis unreachable, falling back to PG path: %s", e)
                _init_logged = True
            else:
                logger.debug("Redis unreachable: %s", e)
            return None


async def close_redis() -> None:
    """Close the shared client. Call on graceful shutdown."""
    global _client
    if _client is not None:
        try:
            await _client.aclose()
        except Exception as e:
            logger.debug("Error closing Redis client: %s", e)
        _client = None


def k(suffix: str) -> str:
    """Build a namespaced Redis key.

    Centralizing prefix application keeps the wire format consistent and
    makes it easy to share a Redis instance with other apps.
    """
    return f"{settings.redis_key_prefix}{suffix}"


def _redact_url(url: str) -> str:
    """Redact password from a redis:// URL for logging."""
    if "@" not in url:
        return url
    scheme_and_rest = url.split("://", 1)
    if len(scheme_and_rest) != 2:
        return url
    scheme, rest = scheme_and_rest
    if "@" in rest:
        _creds, host = rest.split("@", 1)
        return f"{scheme}://***@{host}"
    return url
