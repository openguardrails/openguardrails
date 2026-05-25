"""
Distributed locks for OpenGuardrails (Phase 2).

Replaces `pg_try_advisory_lock` / `pg_advisory_unlock` calls used by the
DB-init and migration runner. The new implementation uses Redis when
configured (`REDIS_URL` set), with a transparent fallback to PostgreSQL
advisory locks for deployments that haven't yet provisioned Redis. This
allows the migration to proceed without breaking existing setups.

Two flavors are exposed:

* `acquire_async(...)` — for callers inside an event loop (e.g.,
  `database.connection.init_db()` which is `async def`).
* `acquire_sync(...)` — for purely sync call paths
  (`migrations.run_migrations()` is invoked synchronously from a few
  scripts plus from inside the async init via direct call).

Both return a `LockHandle` opaque token; callers must release it.

Lock semantics:
- Non-blocking acquire (matches `pg_try_advisory_lock`): if another
  process holds it, the call returns `None` immediately.
- Bounded by `ttl_seconds` on the Redis path so a crashed holder does
  not pin the lock forever. The PG path is session-scoped, so the lock
  is released automatically if the connection dies.
- Safe release on the Redis path: a Lua script deletes the key only if
  the stored value still matches the token we wrote, preventing a
  caller from accidentally releasing someone else's lock after their
  own TTL expired.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from typing import Optional

from sqlalchemy import text
from sqlalchemy.engine import Engine

from services.redis_client import get_redis, is_redis_enabled, k
from utils.logger import setup_logger

logger = setup_logger()

# Lua script: delete key only if its value still equals the supplied
# token. Prevents a caller from releasing someone else's lock after the
# original TTL expired and a different process re-acquired it.
_RELEASE_SCRIPT = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
end
return 0
"""


@dataclass
class LockHandle:
    """Opaque token representing an acquired lock. Pass to release()."""
    name: str
    backend: str  # 'redis' | 'pg'
    token: str    # redis: random hex; pg: str(lock_key)
    # For the PG path we keep the autocommit connection open; advisory
    # locks are session-scoped, so closing the connection releases the
    # lock automatically — we therefore carry the connection here.
    _pg_conn: Optional[object] = None


# ---------------------------------------------------------------------------
# Async API
# ---------------------------------------------------------------------------


async def acquire_async(
    name: str,
    ttl_seconds: int = 600,
    pg_fallback_engine: Optional[Engine] = None,
    pg_fallback_lock_key: Optional[int] = None,
) -> Optional[LockHandle]:
    """Try to acquire `name` non-blockingly.

    Args:
        name: Logical lock name (e.g., "db_init"). Used as the Redis key
            (with the global key prefix) and as the human-readable label
            for logs.
        ttl_seconds: Auto-release TTL for the Redis path. Should be set
            generously larger than the longest expected critical section
            so a slow-but-alive holder doesn't get its lock yanked.
        pg_fallback_engine: SQLAlchemy engine to use if Redis is not
            configured or unreachable. When None, no fallback is
            attempted and the function returns None on Redis failure.
        pg_fallback_lock_key: 64-bit int key used by PG `pg_try_advisory_lock`.
            Required when pg_fallback_engine is provided.

    Returns:
        A LockHandle if acquired, or None if the lock is held elsewhere
        (or both Redis and PG are unavailable).
    """
    # Try Redis first.
    if is_redis_enabled():
        client = await get_redis()
        if client is not None:
            token = secrets.token_hex(16)
            try:
                ok = await client.set(
                    k(f"lock:{name}"),
                    token,
                    nx=True,
                    ex=ttl_seconds,
                )
                if ok:
                    return LockHandle(name=name, backend="redis", token=token)
                return None  # Held by someone else
            except Exception as e:
                logger.warning(
                    "Redis lock '%s' acquire failed, considering PG fallback: %s",
                    name, e,
                )
                # Fall through to PG fallback below.

    # PG fallback path.
    if pg_fallback_engine is not None and pg_fallback_lock_key is not None:
        return _pg_try_acquire(name, pg_fallback_engine, pg_fallback_lock_key)

    return None


async def release_async(handle: Optional[LockHandle]) -> None:
    """Release a lock obtained via acquire_async(). Safe to pass None."""
    if handle is None:
        return
    if handle.backend == "redis":
        client = await get_redis()
        if client is None:
            # Redis went away; the TTL will eventually clean up the key.
            return
        try:
            await client.eval(_RELEASE_SCRIPT, 1, k(f"lock:{handle.name}"), handle.token)
        except Exception as e:
            logger.debug("Redis lock '%s' release error: %s", handle.name, e)
        return

    if handle.backend == "pg":
        _pg_release(handle)


# ---------------------------------------------------------------------------
# Sync API (for call sites that aren't inside an event loop)
# ---------------------------------------------------------------------------


def acquire_sync(
    name: str,
    ttl_seconds: int = 600,
    pg_fallback_engine: Optional[Engine] = None,
    pg_fallback_lock_key: Optional[int] = None,
) -> Optional[LockHandle]:
    """Sync variant of acquire_async. See that function for parameter docs."""
    # Sync Redis path.
    if is_redis_enabled():
        client = _get_sync_redis()
        if client is not None:
            token = secrets.token_hex(16)
            try:
                ok = client.set(
                    k(f"lock:{name}"),
                    token,
                    nx=True,
                    ex=ttl_seconds,
                )
                if ok:
                    return LockHandle(name=name, backend="redis", token=token)
                return None
            except Exception as e:
                logger.warning(
                    "Redis (sync) lock '%s' acquire failed, considering PG fallback: %s",
                    name, e,
                )

    if pg_fallback_engine is not None and pg_fallback_lock_key is not None:
        return _pg_try_acquire(name, pg_fallback_engine, pg_fallback_lock_key)

    return None


def release_sync(handle: Optional[LockHandle]) -> None:
    """Release a lock obtained via acquire_sync(). Safe to pass None."""
    if handle is None:
        return
    if handle.backend == "redis":
        client = _get_sync_redis()
        if client is None:
            return
        try:
            client.eval(_RELEASE_SCRIPT, 1, k(f"lock:{handle.name}"), handle.token)
        except Exception as e:
            logger.debug("Redis (sync) lock '%s' release error: %s", handle.name, e)
        return

    if handle.backend == "pg":
        _pg_release(handle)


# ---------------------------------------------------------------------------
# Internals: PG fallback
# ---------------------------------------------------------------------------


def _pg_try_acquire(name: str, engine: Engine, lock_key: int) -> Optional[LockHandle]:
    """PG advisory lock acquisition — preserves the legacy semantics.

    Returns a LockHandle holding an open autocommit connection. The
    advisory lock is session-scoped, so we MUST keep this connection
    alive until release time.
    """
    try:
        conn = engine.connect().execution_options(isolation_level="AUTOCOMMIT")
        result = conn.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": lock_key})
        acquired = bool(result.scalar())
        if acquired:
            return LockHandle(name=name, backend="pg", token=str(lock_key), _pg_conn=conn)
        # Not acquired: close the connection so we don't leak it.
        conn.close()
        return None
    except Exception as e:
        logger.warning("PG advisory lock '%s' acquire failed: %s", name, e)
        return None


def _pg_release(handle: LockHandle) -> None:
    conn = handle._pg_conn
    if conn is None:
        return
    try:
        conn.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": int(handle.token)})
    except Exception as e:
        logger.debug("PG advisory lock '%s' release error: %s", handle.name, e)
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Internals: lazy sync redis import
# ---------------------------------------------------------------------------

_sync_client = None


def _get_sync_redis():
    """Lazy sync Redis client, paired with the async one in redis_client.py.

    Locks are infrequent (init, migrations) so keeping a separate sync
    client is cheap and avoids forcing async-bridge code on the
    sync-only migration runner.
    """
    global _sync_client
    if _sync_client is not None:
        return _sync_client
    try:
        import redis as redis_sync  # type: ignore
        from config import settings
    except ImportError:
        return None
    if not settings.redis_url:
        return None
    try:
        client = redis_sync.from_url(
            settings.redis_url,
            password=settings.redis_password or None,
            socket_timeout=settings.redis_socket_timeout,
            socket_connect_timeout=settings.redis_socket_timeout,
            decode_responses=False,
        )
        client.ping()
        _sync_client = client
        return _sync_client
    except Exception as e:
        logger.debug("Sync Redis init failed: %s", e)
        return None
