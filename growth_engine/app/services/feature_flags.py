"""
Growth feature flag service.

Reads feature flags from growth.feature_flags with a 60-second in-process
TTL cache. Falls back to the env-var value if the DB read fails, so a DB
outage never disables a flag that was previously running.

Allowed flags:
  growth_graph_priority  — prioritise scoring queue by relationship strength
  learning_loop          — use per-org learned scoring thresholds

Cache semantics:
  cache hit  → cached value (TTL 60s)
  cache miss → DB lookup → cache result
  DB failure → env fallback (settings.growth_graph_priority_enabled /
               settings.learning_loop_enabled)
  unknown key → env fallback if mapped, otherwise False
"""

from __future__ import annotations

import time
import uuid
from typing import Optional

import asyncpg

from app.config import settings
from app.logging_config import get_logger

log = get_logger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────

ALLOWED_FLAGS = frozenset({"growth_graph_priority", "learning_loop"})

# Env-var fallbacks keyed by flag name
_ENV_FALLBACK: dict[str, bool] = {
    "growth_graph_priority": settings.growth_graph_priority_enabled,
    "learning_loop":         settings.learning_loop_enabled,
}

# ── In-process TTL cache ───────────────────────────────────────────────────────
# Structure: { (key, environment): (enabled: bool, fetched_at: float) }
_CACHE: dict[tuple[str, str], tuple[bool, float]] = {}
_TTL_SECONDS = 60


def _cache_get(key: str, environment: str) -> bool | None:
    """Return cached value if still fresh, else None."""
    entry = _CACHE.get((key, environment))
    if entry is None:
        return None
    value, fetched_at = entry
    if time.monotonic() - fetched_at > _TTL_SECONDS:
        return None
    return value


def _cache_set(key: str, environment: str, value: bool) -> None:
    _CACHE[(key, environment)] = (value, time.monotonic())


def _env_fallback(key: str) -> bool:
    """Return the env-var value for a flag (safe default: False)."""
    return _ENV_FALLBACK.get(key, False)


# ── Public API ────────────────────────────────────────────────────────────────

async def get_flag(pool: asyncpg.Pool, key: str) -> bool:
    """
    Return the current value of a feature flag for the active environment.

    Reads from cache if fresh; otherwise queries DB; falls back to env var on error.
    """
    environment = settings.environment

    cached = _cache_get(key, environment)
    if cached is not None:
        return cached

    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT enabled
                FROM growth.feature_flags
                WHERE key = $1 AND environment = $2
                """,
                key,
                environment,
            )
        if row is None:
            # Flag row not seeded yet — use env fallback
            value = _env_fallback(key)
            log.warning("feature_flag_row_missing", key=key, environment=environment, fallback=value)
        else:
            value = bool(row["enabled"])
        _cache_set(key, environment, value)
        return value
    except Exception as exc:
        fallback = _env_fallback(key)
        log.warning(
            "feature_flag_db_read_failed",
            key=key, environment=environment, fallback=fallback, error=str(exc),
        )
        return fallback


async def set_flag(
    pool: asyncpg.Pool,
    key: str,
    enabled: bool,
    updated_by_user_id: Optional[uuid.UUID] = None,
) -> None:
    """
    Persist a flag value and invalidate the local cache entry.

    Only ALLOWED_FLAGS keys are accepted — callers must validate before calling.
    """
    environment = settings.environment
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE growth.feature_flags
            SET    enabled             = $1,
                   updated_at          = NOW(),
                   updated_by_user_id  = $2
            WHERE  key = $3 AND environment = $4
            """,
            enabled,
            updated_by_user_id,
            key,
            environment,
        )
    # Invalidate cache so next read gets the fresh value
    _CACHE.pop((key, environment), None)
    log.info(
        "feature_flag_set",
        key=key, environment=environment, enabled=enabled,
        updated_by=str(updated_by_user_id) if updated_by_user_id else None,
    )


async def list_flags(pool: asyncpg.Pool) -> list[dict]:
    """
    Return all flags for the active environment, annotated with live DB values.
    """
    environment = settings.environment
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT key, enabled, updated_at, updated_by_user_id
            FROM growth.feature_flags
            WHERE environment = $1
            ORDER BY key
            """,
            environment,
        )
    return [dict(r) for r in rows]
