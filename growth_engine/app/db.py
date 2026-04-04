"""
Async Postgres connection pool using asyncpg.

One pool per process — created at FastAPI lifespan startup, closed on shutdown.
All database access goes through `get_pool()` FastAPI dependency or
`pool.acquire()` context manager in workers.

We do NOT use SQLAlchemy ORM. Raw asyncpg SQL for:
  - Full control over locking (SELECT ... FOR UPDATE SKIP LOCKED)
  - Explicit transaction management
  - No N+1 surprises from ORM lazy loading
  - Easier reasoning about what hits the DB
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import AsyncGenerator

import asyncpg

from app.config import settings
from app.logging_config import get_logger

log = get_logger(__name__)

# Module-level pool — None until lifespan startup sets it.
_pool: asyncpg.Pool | None = None


async def init_pool() -> asyncpg.Pool:
    """
    Create the asyncpg connection pool.
    Called once inside FastAPI lifespan startup.
    """
    global _pool
    log.info(
        "db_pool_initializing",
        min_size=settings.db_pool_min_size,
        max_size=settings.db_pool_max_size,
    )
    _pool = await asyncpg.create_pool(
        dsn=settings.database_url,
        min_size=settings.db_pool_min_size,
        max_size=settings.db_pool_max_size,
        # Ensure asyncpg returns dicts/records with column access by name
        command_timeout=30,
        # Supabase uses PgBouncer in transaction pool_mode which does not support
        # prepared statements. Disable asyncpg's statement cache to avoid
        # "prepared statement does not exist" errors.
        statement_cache_size=0,
    )
    log.info("db_pool_ready")
    return _pool


async def close_pool() -> None:
    """
    Gracefully close the connection pool.
    Called inside FastAPI lifespan shutdown.
    """
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
        log.info("db_pool_closed")


def get_pool() -> asyncpg.Pool:
    """
    FastAPI dependency — returns the active pool.
    Raises RuntimeError if called before lifespan startup.
    """
    if _pool is None:
        raise RuntimeError(
            "DB pool is not initialized. "
            "Ensure init_pool() is called inside the FastAPI lifespan."
        )
    return _pool


@asynccontextmanager
async def transaction(pool: asyncpg.Pool) -> AsyncGenerator[asyncpg.Connection, None]:
    """
    Convenience context manager: acquire connection + open transaction.

    Usage:
        async with transaction(pool) as conn:
            await conn.execute(...)

    Automatically rolls back on exception, commits on clean exit.
    """
    async with pool.acquire() as conn:
        async with conn.transaction():
            yield conn
