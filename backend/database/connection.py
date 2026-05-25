import logging

from sqlalchemy import create_engine
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from config import settings

_url_logger = logging.getLogger(__name__)


def _async_database_url(url: str) -> str:
    """Translate the sync DATABASE_URL into the async-driver form.

    Phase 3 introduced asyncpg-backed engines side-by-side with the
    legacy psycopg2 engines so operators wouldn't have to change their
    env. Phase 4a extends the same translator to MySQL/MariaDB so a
    single `DATABASE_URL=mysql://...` env spawns the correct async
    engine.

    Supported rewrites:

        postgresql://...           -> postgresql+asyncpg://...
        postgresql+psycopg2://...  -> postgresql+asyncpg://...
        postgresql+asyncpg://...   -> unchanged (already async)

        mysql://...                -> mysql+aiomysql://...
        mysql+pymysql://...        -> mysql+aiomysql://...
        mysql+mysqldb://...        -> mysql+aiomysql://...
        mysql+aiomysql://...       -> unchanged (already async)
        mysql+asyncmy://...        -> unchanged (asyncmy is also async,
                                                  let the operator's
                                                  explicit driver win)

        mariadb://...              -> mariadb+aiomysql://...
        mariadb+pymysql://...      -> mariadb+aiomysql://...
        mariadb+mariadbconnector://-> mariadb+aiomysql://...
        mariadb+aiomysql://...     -> unchanged
        mariadb+asyncmy://...      -> unchanged

        sqlite://... and anything else -> unchanged + logged warning.
            Tests / dev sometimes use sqlite; rewriting it to a non-
            existent async driver would just confuse the error. We log
            a warning so operators who set an unsupported production
            DB see *something* before SQLAlchemy errors out.

    The rewrite is purely a string operation; we do not validate that
    the rest of the URL (host, credentials) makes sense — SQLAlchemy
    will surface that at engine creation.
    """
    # Fast paths: already-async URLs we recognize.
    if url.startswith((
        "postgresql+asyncpg://",
        "mysql+aiomysql://",
        "mysql+asyncmy://",
        "mariadb+aiomysql://",
        "mariadb+asyncmy://",
    )):
        return url

    # PostgreSQL (sync drivers + bare scheme).
    if url.startswith("postgresql+psycopg2://"):
        return "postgresql+asyncpg://" + url[len("postgresql+psycopg2://"):]
    if url.startswith("postgresql://"):
        return "postgresql+asyncpg://" + url[len("postgresql://"):]

    # MySQL (sync drivers + bare scheme).
    if url.startswith("mysql+pymysql://"):
        return "mysql+aiomysql://" + url[len("mysql+pymysql://"):]
    if url.startswith("mysql+mysqldb://"):
        return "mysql+aiomysql://" + url[len("mysql+mysqldb://"):]
    if url.startswith("mysql://"):
        return "mysql+aiomysql://" + url[len("mysql://"):]

    # MariaDB (sync drivers + bare scheme). MariaDB is a distinct
    # SQLAlchemy dialect from MySQL — it activates MariaDB-specific
    # rendering in some places — so we preserve the operator's choice
    # rather than collapsing it to mysql.
    if url.startswith("mariadb+pymysql://"):
        return "mariadb+aiomysql://" + url[len("mariadb+pymysql://"):]
    if url.startswith("mariadb+mariadbconnector://"):
        return "mariadb+aiomysql://" + url[len("mariadb+mariadbconnector://"):]
    if url.startswith("mariadb://"):
        return "mariadb+aiomysql://" + url[len("mariadb://"):]

    # Unknown scheme — pass through but log so operators notice. We
    # deliberately don't raise: sqlite:/// is legitimate for tests, and
    # raising here would block the import of database/connection.py
    # which would take the whole app down before the error has any
    # useful context.
    _url_logger.warning(
        "Unrecognized DATABASE_URL scheme; passing through to SQLAlchemy "
        "without async rewrite. URL prefix=%r. Supported async dialects: "
        "postgresql, mysql, mariadb.",
        url.split("://", 1)[0] + "://" if "://" in url else url[:30],
    )
    return url


def get_dialect_name() -> str:
    """Return the SQLAlchemy dialect name of the configured DATABASE_URL.

    Reads from `admin_engine.dialect.name` once it's been constructed.
    Call sites that need to branch on dialect (Phase 4a service-code
    sweep) should use this rather than re-parsing the URL.

    Returns one of: 'postgresql', 'mysql', 'mariadb', 'sqlite', ...
    """
    return admin_engine.dialect.name

# Create PostgreSQL database engine - optimized for separated services
# Detection service engine - minimal connection pool (only for authentication)
detection_engine = create_engine(
    settings.database_url,
    pool_size=5,  # Detection service needs connections for concurrent async requests (data security, scanner detection, etc.)
    max_overflow=10,  # Allow burst connections for parallel detection workloads
    pool_pre_ping=True,
    pool_recycle=1800,
    pool_timeout=30,
    echo=False
)

# Management service engine - low concurrency optimization
admin_engine = create_engine(
    settings.database_url,
    pool_size=10,  # Management service connection pool (increased for better concurrency)
    max_overflow=20,  # Management service overflow connection (increased for peak loads)
    pool_pre_ping=True,
    pool_recycle=1800,
    pool_timeout=30,
    echo=False
)

# Proxy service engine - medium concurrency optimization
proxy_engine = create_engine(
    settings.database_url,
    pool_size=3,  # Proxy service connection pool (reduced from 5)
    max_overflow=5,  # Proxy service overflow connection (reduced from 10)
    pool_pre_ping=True,
    pool_recycle=1800,
    pool_timeout=30,
    echo=False
)

# Default engine (backward compatibility)
engine = detection_engine

# Create session - separated services
DetectionSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=detection_engine)
AdminSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=admin_engine)
ProxySessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=proxy_engine)

# Default session (backward compatibility)
SessionLocal = DetectionSessionLocal

# Create base class
Base = declarative_base()

def get_database_url():
    """Get database URL"""
    return settings.database_url

def get_db():
    """Get database session"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def get_admin_db():
    """Get admin service database session"""
    db = AdminSessionLocal()
    try:
        yield db
    finally:
        db.close()

def get_proxy_db():
    """Get proxy service database session"""
    db = ProxySessionLocal()
    try:
        yield db
    finally:
        db.close()

def get_db_session():
    """Get database session (non-generator version)"""
    return SessionLocal()

def get_detection_db_session():
    """Get detection service database session"""
    return DetectionSessionLocal()

def get_admin_db_session():
    """Get management service database session"""
    return AdminSessionLocal()

def get_proxy_db_session():
    """Get proxy service database session"""
    return ProxySessionLocal()


# ---------------------------------------------------------------------------
# Phase 3: async engines and sessions (asyncpg).
#
# These coexist with the sync engines above so routers can be migrated
# one at a time. Once a router is fully async it should depend on the
# `get_async_*_db` providers below; the sync `get_*_db` providers stay
# until every router is migrated, at which point the sync engines and
# psycopg2 dependency are dropped.
#
# Hard rule during migration: a single async route must NOT call any
# code that uses a sync Session — that re-blocks the event loop and
# defeats the point of the migration. If a service helper still takes
# a sync Session, either convert it or wrap the call in
# `asyncio.to_thread()` as a temporary measure.
# ---------------------------------------------------------------------------

_ASYNC_DATABASE_URL = _async_database_url(settings.database_url)

async_admin_engine = create_async_engine(
    _ASYNC_DATABASE_URL,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,
    pool_recycle=1800,
    pool_timeout=30,
    echo=False,
)

async_detection_engine = create_async_engine(
    _ASYNC_DATABASE_URL,
    pool_size=5,
    max_overflow=10,
    pool_pre_ping=True,
    pool_recycle=1800,
    pool_timeout=30,
    echo=False,
)

async_proxy_engine = create_async_engine(
    _ASYNC_DATABASE_URL,
    pool_size=3,
    max_overflow=5,
    pool_pre_ping=True,
    pool_recycle=1800,
    pool_timeout=30,
    echo=False,
)

# `expire_on_commit=False` is the recommended default for AsyncSession:
# accessing attributes on an ORM object after commit shouldn't trigger
# an implicit lazy-load against an already-closed session.
AsyncAdminSessionLocal = async_sessionmaker(
    bind=async_admin_engine, expire_on_commit=False, class_=AsyncSession
)
AsyncDetectionSessionLocal = async_sessionmaker(
    bind=async_detection_engine, expire_on_commit=False, class_=AsyncSession
)
AsyncProxySessionLocal = async_sessionmaker(
    bind=async_proxy_engine, expire_on_commit=False, class_=AsyncSession
)


async def get_async_admin_db():
    """FastAPI dependency: yields an AsyncSession bound to the admin pool."""
    async with AsyncAdminSessionLocal() as db:
        yield db


async def get_async_detection_db():
    """FastAPI dependency: yields an AsyncSession bound to the detection pool."""
    async with AsyncDetectionSessionLocal() as db:
        yield db


async def get_async_proxy_db():
    """FastAPI dependency: yields an AsyncSession bound to the proxy pool."""
    async with AsyncProxySessionLocal() as db:
        yield db


# Non-generator factories. Use these from service code that creates its
# own short-lived session (e.g., the detection service spawning a
# session inside an `async with` block to look up a single row), not
# from FastAPI route dependencies. The naming mirrors the legacy
# `get_admin_db_session()` / `get_detection_db_session()` helpers.
def get_async_admin_db_session() -> AsyncSession:
    """Return a fresh AsyncSession bound to the admin pool. Caller owns
    it — typical usage:

        async with get_async_admin_db_session() as db:
            ...

    AsyncSession supports the async-context-manager protocol, so the
    `async with` block closes it automatically.
    """
    return AsyncAdminSessionLocal()


def get_async_detection_db_session() -> AsyncSession:
    """Return a fresh AsyncSession bound to the detection pool. See
    get_async_admin_db_session() for usage."""
    return AsyncDetectionSessionLocal()


def get_async_proxy_db_session() -> AsyncSession:
    """Return a fresh AsyncSession bound to the proxy pool."""
    return AsyncProxySessionLocal()


def create_detection_engine():
    """Create detection service engine"""
    return detection_engine

def create_admin_engine():
    """Create management service engine"""
    return admin_engine

def create_proxy_engine():
    """Create proxy service engine"""
    return proxy_engine

async def init_db(minimal=False):
    """Initialize database, using a distributed lock so only one worker
    runs the DDL/seed path on a multi-process deployment.

    Phase 2: the lock is held in Redis when REDIS_URL is set; otherwise
    it falls back to the legacy `pg_try_advisory_lock`. Same non-blocking
    semantics either way.

    Args:
        minimal: Whether to minimize initialization (detection service used)
    """
    from database.models import (
        DetectionResult, Blacklist, Whitelist, ResponseTemplate, SystemConfig,
        Tenant, EmailVerification, TenantSwitch
    )
    from services.admin_service import admin_service
    from services.distributed_lock import acquire_async, release_async
    from utils.logger import setup_logger

    logger = setup_logger()
    # Same 64-bit key the legacy code used; carried over for the PG
    # fallback path so existing deployments mid-rolling-restart see
    # consistent locking semantics.
    pg_lock_key = 0x5A6F_5858_4941_4752

    # Management service is responsible for full initialization
    init_engine = admin_engine if not minimal else detection_engine

    handle = await acquire_async(
        name="db_init",
        ttl_seconds=600,
        pg_fallback_engine=init_engine,
        pg_fallback_lock_key=pg_lock_key,
    )

    if handle is None:
        # Another worker is initializing — wait briefly and verify database is ready.
        logger.info("Another process is initializing database, waiting...")
        import asyncio
        await asyncio.sleep(2)

        try:
            with init_engine.connect() as verify_conn:
                verify_conn.execute(text("SELECT 1 FROM tenants LIMIT 1"))
            logger.info("Database initialization completed by another process")
            return
        except Exception as e:
            logger.warning(f"Database not ready yet, waiting longer... ({e})")
            await asyncio.sleep(3)
            return

    try:
        # Execute DDL and initialization in a new transaction; the
        # distributed lock above already serializes us against other
        # workers, so this transaction can use a regular pooled
        # connection without locking concerns.
        with init_engine.begin() as tx_conn:
            if settings.reset_database_on_startup:
                # Safely cascade delete all tables, maintain backward compatibility with old data format
                try:
                    # Try to delete tables with foreign key dependencies first
                    tx_conn.execute(text("DROP TABLE IF EXISTS proxy_configs CASCADE"))
                    tx_conn.execute(text("DROP TABLE IF EXISTS email_verifications CASCADE"))
                    tx_conn.execute(text("DROP TABLE IF EXISTS user_switches CASCADE"))
                    # Then delete other tables
                    Base.metadata.drop_all(bind=tx_conn)
                except Exception as e:
                    # If there is still a problem, use cascade delete
                    tx_conn.execute(text("DROP SCHEMA public CASCADE"))
                    tx_conn.execute(text("CREATE SCHEMA public"))
                    tx_conn.execute(text("GRANT ALL ON SCHEMA public TO public"))

            # checkfirst=True (default), only create missing tables, maintain backward compatibility
            Base.metadata.create_all(bind=tx_conn)

        # Run database migrations FIRST - BEFORE any data initialization
        # This ensures new columns (like tenants.created_by_tenant_id) exist before they're queried
        # Critical for upgrades where tables exist but new columns don't
        if not minimal:
            logger.info("Running database migrations...")
            try:
                from pathlib import Path
                import importlib.util

                # Import and run migrations module
                migrations_path = Path(__file__).parent.parent / "migrations" / "run_migrations.py"
                if migrations_path.exists():
                    spec = importlib.util.spec_from_file_location("run_migrations", migrations_path)
                    migrations_module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(migrations_module)

                    # Run migrations (uses its own distributed lock; harmless re-entry)
                    executed, failed = migrations_module.run_migrations(dry_run=False)
                    if failed > 0:
                        logger.error(f"Database migrations failed: {failed} migration(s) failed")
                    else:
                        logger.info(f"Database migrations completed: {executed} migration(s) executed")
                else:
                    logger.warning("Migrations directory not found, skipping migrations")
            except Exception as e:
                logger.error(f"Failed to run migrations: {e}")
                import traceback
                traceback.print_exc()

        # Now initialize data AFTER migrations have run
        # This ensures new columns (like tenants.created_by_tenant_id) exist
        if not minimal:
            init_data_db = AdminSessionLocal()
            try:
                # Create super admin account (idempotent)
                admin_service.create_super_admin_if_not_exists(init_data_db)

                # Initialize default data (idempotent)
                existing_config = init_data_db.query(SystemConfig).filter_by(config_key="initialized").first()
                if not existing_config:
                    default_configs = [
                        SystemConfig(config_key="initialized", config_value="true", description="System initialization flag"),
                        SystemConfig(config_key="default_action", config_value="reject", description="Default action for high risk content"),
                    ]

                    default_responses = [
                        ResponseTemplate(category="S1", risk_level="high_risk", template_content="I'm sorry, I can't discuss political topics.", is_default=True),
                        ResponseTemplate(category="S2", risk_level="high_risk", template_content="I'm sorry, I can't answer questions involving sensitive political topics.", is_default=True),
                        ResponseTemplate(category="S3", risk_level="high_risk", template_content="I'm sorry, I can't answer questions that may damage national image.", is_default=True),
                        ResponseTemplate(category="S4", risk_level="high_risk", template_content="I'm sorry, I can't provide content that may harm minors.", is_default=True),
                        ResponseTemplate(category="S5", risk_level="high_risk", template_content="I'm sorry, I can't answer questions involving violent crime.", is_default=True),
                        ResponseTemplate(category="S6", risk_level="high_risk", template_content="I'm sorry, I can't provide content involving illegal activities.", is_default=True),
                        ResponseTemplate(category="S7", risk_level="high_risk", template_content="I'm sorry, I can't provide content involving pornography.", is_default=True),
                        ResponseTemplate(category="S8", risk_level="high_risk", template_content="I'm sorry, but I cannot engage with content containing hate speech or discrimination.", is_default=True),
                        ResponseTemplate(category="S9", risk_level="high_risk", template_content="I'm sorry, I can't answer questions involving prompt injection attacks.", is_default=True),
                        ResponseTemplate(category="S10", risk_level="high_risk", template_content="I'm sorry, but I cannot respond to profanity or offensive language.", is_default=True),
                        ResponseTemplate(category="S11", risk_level="high_risk", template_content="I'm sorry, I can't discuss content involving personal privacy. Please respect others' privacy.", is_default=True),
                        ResponseTemplate(category="S12", risk_level="high_risk", template_content="I'm sorry, I can't provide advice on possible business violations. Please consult with a professional.", is_default=True),
                        ResponseTemplate(category="default", risk_level="high_risk", template_content="I'm sorry, I can't answer this question. Please contact customer service if you have any questions.", is_default=True),
                    ]

                    for config in default_configs:
                        init_data_db.add(config)
                    for response in default_responses:
                        init_data_db.add(response)
                    init_data_db.commit()
            except Exception as e:
                logger.error(f"Failed to initialize data: {e}")
                import traceback
                traceback.print_exc()
            finally:
                init_data_db.close()

        # Ensure global data security entity types exist (language-aware)
        # These are re-created after migration 068 deletes old ones
        if not minimal:
            from services.data_security_service import create_global_entity_types
            entity_db = AdminSessionLocal()
            try:
                admin_tenant = entity_db.execute(
                    text("SELECT id FROM tenants WHERE is_super_admin = true LIMIT 1")
                ).fetchone()
                if admin_tenant:
                    created = create_global_entity_types(entity_db, str(admin_tenant[0]))
                    if created > 0:
                        logger.info(f"Created {created} global data security entity types")
            except Exception as e:
                logger.error(f"Failed to ensure global entity types: {e}")
            finally:
                entity_db.close()

        # Load built-in scanner packages AFTER migrations have run
        # This ensures columns like applications.source exist before being queried
        if not minimal:
            from services.builtin_scanner_loader import load_builtin_scanner_packages

            loader_db = AdminSessionLocal()
            try:
                summary = load_builtin_scanner_packages(loader_db)
                logger.info(
                    "Built-in scanner packages ensured (packages=%d, scanners=%d)",
                    summary["packages"],
                    summary["scanners"],
                )
            except FileNotFoundError as err:
                logger.warning("Built-in scanners directory missing: %s", err)
            except Exception as err:
                logger.error(f"Failed to load built-in scanner packages: {err}")
                raise
            finally:
                loader_db.close()
    finally:
        # Release the distributed lock. Safe even if Redis is now down —
        # the Redis path silently no-ops and the TTL eventually cleans up.
        await release_async(handle)
