"""Test fixtures for schema-portability tests.

`DATABASE_URL` is read from the environment (CI matrix sets it
per-job). Each test gets a fresh database — we DROP/CREATE the public
schema (PG) or DROP/CREATE the database itself (MySQL) before running
the migration runner.

Tests are dialect-aware: skip a test with `pytest.skip` only when
something genuinely cannot run on a given backend (none today —
everything we ship must run on both).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Iterator
from urllib.parse import urlparse, urlunparse

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

# Make the backend importable. Tests live under backend/tests; the
# repo's existing run scripts assume `cwd == backend/` and put it on
# sys.path implicitly. Replicate that.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.exit(
            "DATABASE_URL is required for the test suite. CI sets it per-matrix-job; "
            "for local runs export `postgresql://...` or `mysql+pymysql://...`."
        )
    return url


def _admin_url(url: str) -> str:
    """Return a URL pointing at the dialect's admin DB so we can DROP/CREATE.

    PG: connect to `postgres` instead of the target DB. MySQL: connect
    without a default DB.
    """
    parsed = urlparse(url)
    if parsed.scheme.startswith("postgres"):
        return urlunparse(parsed._replace(path="/postgres"))
    if parsed.scheme.startswith("mysql"):
        return urlunparse(parsed._replace(path="/"))
    raise RuntimeError(f"Unsupported dialect: {parsed.scheme}")


def _db_name(url: str) -> str:
    return urlparse(url).path.lstrip("/")


def _reset_database(url: str) -> None:
    """Drop and re-create the target database. PG can't `DROP DATABASE`
    while connected to it, so we connect to the admin DB. Stale
    connections from prior tests' engines need to be terminated first
    or the DROP fails with `database is being accessed by other users`.
    """
    admin = create_engine(_admin_url(url), isolation_level="AUTOCOMMIT")
    name = _db_name(url)
    try:
        with admin.connect() as conn:
            if "postgresql" in url:
                # Kick existing sessions before dropping. PG's
                # pg_terminate_backend works because we're connected to
                # `postgres`, not the target DB.
                conn.execute(
                    text(
                        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                        "WHERE datname = :name AND pid <> pg_backend_pid()"
                    ),
                    {"name": name},
                )
                conn.execute(text(f'DROP DATABASE IF EXISTS "{name}"'))
                conn.execute(text(f'CREATE DATABASE "{name}"'))
            else:
                conn.execute(text(f"DROP DATABASE IF EXISTS `{name}`"))
                conn.execute(text(f"CREATE DATABASE `{name}`"))
    finally:
        admin.dispose()


@pytest.fixture(scope="session")
def fresh_db_url() -> str:
    """A fresh DB created once per pytest session. All tests share it;
    each test isolates itself by writing rows under a UUID-derived
    namespace (email, name, request_id, etc.).

    Per-test reset would be ~10s per test × N tests; sharing the DB
    keeps the suite under a minute and still gives genuine portability
    coverage."""
    url = _database_url()
    _reset_database(url)
    return url


@pytest.fixture(scope="session")
def bootstrapped_engine(fresh_db_url: str) -> Iterator[Engine]:
    """Run the migration pipeline once per session against
    `fresh_db_url`. Tests get an engine ready for queries; each test
    is responsible for namespacing its writes (UUIDs).

    Redis is forced off (`REDIS_URL=""`) so the runner doesn't try to
    grab a Redis lock that isn't available in CI.
    """
    os.environ["DATABASE_URL"] = fresh_db_url
    os.environ.setdefault("REDIS_URL", "")

    # Import here so the env var is set before `database.connection`
    # creates its engines.
    from migrations.run_migrations import run_migrations

    executed, failed = run_migrations()
    assert failed == 0, f"Migration runner reported {failed} failures"
    assert executed >= 1, "Expected at least one migration to run on a fresh DB"

    engine = create_engine(fresh_db_url)
    yield engine
    engine.dispose()


@pytest.fixture()
def db_session(bootstrapped_engine: Engine) -> Iterator[Session]:
    Session = sessionmaker(bind=bootstrapped_engine)
    s = Session()
    try:
        yield s
    finally:
        s.close()


def dialect(engine_or_url) -> str:
    """Normalize the dialect name for assertions. Returns one of
    'postgresql', 'mysql' (mariadb collapses to 'mysql')."""
    if hasattr(engine_or_url, "dialect"):
        name = engine_or_url.dialect.name
    else:
        name = urlparse(engine_or_url).scheme.split("+")[0]
        if name == "postgres":
            name = "postgresql"
    return "mysql" if name == "mariadb" else name
