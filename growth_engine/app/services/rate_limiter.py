"""
Growth Engine transport rate limiter.

Uses growth.rate_limit_buckets — a dedicated sliding-window counter table
separate from the commercial engagement_daily_caps and the main GSC
rate_limit_buckets table.

These are transport/control limits to prevent runaway client behaviour.
They are NOT commercial plan limits (those live in engagement_daily_caps).

Window semantics:
  "hour" — window_start is floored to the current UTC hour (truncated at minute=0)
  "day"  — window_start is floored to the current UTC day (midnight)

The counter is atomically incremented with an ON CONFLICT upsert, so
concurrent requests are safe without any application-level locking.

check_rate_limit() returns (allowed, current_count, limit) AFTER the
increment — so if current_count > limit the request is over-limit.

Defined limits (transport layer):
  engage:discover          10 / org / hour
  engage:execute           30 / org / hour
  growth:intelligence:gen   5 / org / day
  growth:metrics:ingest   100 / org / hour
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Literal

import asyncpg

from app.logging_config import get_logger

log = get_logger(__name__)

Window = Literal["hour", "day"]

# ── Canonical route keys and their limits ─────────────────────────────────────
ROUTE_LIMITS: dict[str, tuple[int, Window]] = {
    "engage:discover":         (10,  "hour"),
    "engage:execute":          (30,  "hour"),
    "growth:intelligence:gen": (5,   "day"),
    "growth:metrics:ingest":   (100, "hour"),
}


async def check_rate_limit(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    route_key: str,
    limit: int,
    window: Window = "hour",
) -> tuple[bool, int, int]:
    """
    Increment the counter for (org_id, route_key, window) and return
    whether the request is within the limit.

    Returns: (allowed, count_after_increment, limit)
      allowed=True  → proceed
      allowed=False → respond HTTP 429

    Never raises — on DB error, returns allowed=True to avoid blocking
    legitimate requests (fail-open). The error is logged.
    """
    window_start = _floor_window(window)

    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO growth.rate_limit_buckets
                    (org_id, route_key, window_start, count)
                VALUES ($1, $2, $3, 1)
                ON CONFLICT (org_id, route_key, window_start)
                DO UPDATE SET count = growth.rate_limit_buckets.count + 1
                RETURNING count
                """,
                org_id, route_key, window_start,
            )
        count = row["count"]
    except Exception as exc:
        log.error(
            "rate_limit_db_error",
            org_id=str(org_id), route_key=route_key, error=str(exc),
        )
        # Fail-open: don't block traffic on DB error
        return True, 0, limit

    allowed = count <= limit
    if not allowed:
        log.warning(
            "rate_limit_exceeded",
            org_id=str(org_id), route_key=route_key,
            count=count, limit=limit, window=window,
        )
    return allowed, count, limit


def _floor_window(window: Window) -> datetime:
    """Return current UTC time floored to the start of the current window."""
    now = datetime.now(tz=timezone.utc)
    if window == "hour":
        return now.replace(minute=0, second=0, microsecond=0)
    # day
    return now.replace(hour=0, minute=0, second=0, microsecond=0)
