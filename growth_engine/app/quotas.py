"""
DB-backed quota enforcement for the Growth Engine.

All checks run inside a single transaction with SELECT ... FOR UPDATE.
This makes quota enforcement deterministic under concurrent worker/API load —
two simultaneous requests cannot both pass the same quota check.

──────────────────────────────────────────────────────────────────────────────
TWO SEPARATE ENFORCEMENT SYSTEMS — DO NOT CONFLATE
──────────────────────────────────────────────────────────────────────────────

1. Commercial entitlement counters — growth.plan_usage_daily
   Purpose: enforce what the org's PLAN allows them to do.
   Examples:
     - Starter plan: max 1 content piece/day → checked before writing a draft
     - Engagement Pro: max 15 engagements/day → checked before posting a comment
     - Free tier: 1 post OR 1 image/day, max 15 active days/month
   Functions: check_and_increment_content_quota()
              check_and_increment_engagement_quota()
              check_and_increment_free_generation_quota()

2. Platform safety cap counters — growth.platform_daily_counters
   Purpose: enforce absolute platform-level caps, regardless of commercial plan.
   A Scale plan ($399/mo = 3 content pieces/day) still cannot post >2/day to LinkedIn.
   Examples:
     - LinkedIn: max 2 posts/day, max 10 engagement comments/day
     - X: max 8 posts/day, max 30 replies/day
     - Facebook: max 2 posts/day
     - Instagram: max 2 posts/day
   Functions: check_and_increment_platform_post_cap()
              check_and_increment_platform_engagement_cap()

These are enforced in sequence at publish time:
  → commercial quota check (plan_usage_daily)  ← passes if plan allows it
  → platform safety cap check (platform_daily_counters)  ← always enforced
  → publish

They share no counters, no tables, and no state. Incrementing a platform
counter does NOT affect the commercial quota counter and vice versa.
──────────────────────────────────────────────────────────────────────────────

Tables:
  growth.plan_usage_daily        — commercial quota counters per org per day
  growth.platform_daily_counters — platform safety cap counters per org per platform per day
  growth.org_growth_settings     — plan_key, engagement_plan_key per org

QuotaExceeded is raised (not HTTPException) so callers (API or workers)
can decide how to surface the error (HTTP 429 vs log + skip).
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Literal, Optional

import asyncpg

from app.entitlements import (
    FREE_DAILY_LIMIT_PER_TYPE,
    FREE_MONTHLY_DAY_CAP,
    PLATFORM_ENGAGEMENT_CAPS,
    PLATFORM_POST_CAPS,
    get_content_plan,
    get_engagement_plan,
)
from app.logging_config import get_logger

log = get_logger(__name__)


class QuotaExceeded(Exception):
    """
    Raised when a quota check fails.
    Attributes:
        quota_type: machine-readable category ('content_piece', 'engagement', etc.)
        detail:     human-readable explanation safe to surface in API response.
    """
    def __init__(self, quota_type: str, detail: str) -> None:
        self.quota_type = quota_type
        self.detail = detail
        super().__init__(detail)


# ── Internal helpers ───────────────────────────────────────────────────────────

async def _upsert_and_lock_usage_row(
    conn: asyncpg.Connection,
    org_id: uuid.UUID,
    today: date,
) -> asyncpg.Record:
    """Insert today's row if missing, then lock it FOR UPDATE."""
    await conn.execute(
        """
        INSERT INTO growth.plan_usage_daily (org_id, usage_date)
        VALUES ($1, $2)
        ON CONFLICT (org_id, usage_date) DO NOTHING
        """,
        org_id,
        today,
    )
    return await conn.fetchrow(
        """
        SELECT * FROM growth.plan_usage_daily
        WHERE org_id = $1 AND usage_date = $2
        FOR UPDATE
        """,
        org_id,
        today,
    )


async def _upsert_and_lock_platform_counter(
    conn: asyncpg.Connection,
    org_id: uuid.UUID,
    platform: str,
    today: date,
) -> asyncpg.Record:
    """Insert today's platform counter row if missing, then lock it FOR UPDATE."""
    await conn.execute(
        """
        INSERT INTO growth.platform_daily_counters (org_id, platform, counter_date)
        VALUES ($1, $2, $3)
        ON CONFLICT (org_id, platform, counter_date) DO NOTHING
        """,
        org_id,
        platform,
        today,
    )
    return await conn.fetchrow(
        """
        SELECT * FROM growth.platform_daily_counters
        WHERE org_id = $1 AND platform = $2 AND counter_date = $3
        FOR UPDATE
        """,
        org_id,
        platform,
        today,
    )


async def _fetch_org_plans(
    conn: asyncpg.Connection,
    org_id: uuid.UUID,
) -> asyncpg.Record:
    """
    Fetch plan keys for the org. Raises QuotaExceeded if settings missing
    (org must set up growth settings before any quota check runs).
    """
    row = await conn.fetchrow(
        "SELECT plan_key, engagement_plan_key FROM growth.org_growth_settings WHERE org_id = $1",
        org_id,
    )
    if row is None:
        raise QuotaExceeded(
            quota_type="no_settings",
            detail=(
                "Growth settings not configured for this organization. "
                "Set up your plan before generating content."
            ),
        )
    return row


# ── Public quota functions ─────────────────────────────────────────────────────

async def check_and_increment_content_quota(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    today: date,
) -> None:
    """
    Check that the org has content piece quota remaining for today, then increment.

    Content piece = one idea (counting 1 regardless of how many platform variants
    are generated from it — locked billing rule §D).

    Raises QuotaExceeded if:
      - Org is on free plan (no automation allowed)
      - Daily limit already reached
    """
    async with pool.acquire() as conn:
        async with conn.transaction():
            settings_row = await _fetch_org_plans(conn, org_id)
            plan = get_content_plan(settings_row["plan_key"])

            if not plan.can_automate:
                raise QuotaExceeded(
                    quota_type="content_piece",
                    detail=(
                        f"Content automation is not available on the '{plan.plan_key}' plan. "
                        "Upgrade to Starter ($199/mo) or higher to enable automated posting."
                    ),
                )

            usage_row = await _upsert_and_lock_usage_row(conn, org_id, today)
            used = usage_row["content_pieces_generated"]

            if used >= plan.daily_content_pieces:
                raise QuotaExceeded(
                    quota_type="content_piece",
                    detail=(
                        f"Daily content piece limit reached ({used}/{plan.daily_content_pieces}) "
                        f"on the '{plan.plan_key}' plan. Resets at midnight UTC."
                    ),
                )

            await conn.execute(
                """
                UPDATE growth.plan_usage_daily
                SET content_pieces_generated = content_pieces_generated + 1,
                    updated_at = now()
                WHERE org_id = $1 AND usage_date = $2
                """,
                org_id,
                today,
            )

            log.info(
                "content_quota_consumed",
                org_id=str(org_id),
                plan=plan.plan_key,
                used_after=used + 1,
                daily_limit=plan.daily_content_pieces,
            )


async def check_and_increment_engagement_quota(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    today: date,
) -> None:
    """
    Check engagement quota and increment.

    Raises QuotaExceeded if:
      - No engagement plan active
      - Daily limit already reached
    """
    async with pool.acquire() as conn:
        async with conn.transaction():
            settings_row = await _fetch_org_plans(conn, org_id)
            plan = get_engagement_plan(settings_row["engagement_plan_key"])

            if plan is None:
                raise QuotaExceeded(
                    quota_type="engagement",
                    detail=(
                        "No engagement plan is active. "
                        "Upgrade to Engagement Starter ($99/mo) or Pro ($199/mo)."
                    ),
                )

            usage_row = await _upsert_and_lock_usage_row(conn, org_id, today)
            used = usage_row["engagements_executed"]

            if used >= plan.daily_engagements:
                raise QuotaExceeded(
                    quota_type="engagement",
                    detail=(
                        f"Daily engagement limit reached ({used}/{plan.daily_engagements}) "
                        f"on the '{plan.plan_key}' plan. Resets at midnight UTC."
                    ),
                )

            await conn.execute(
                """
                UPDATE growth.plan_usage_daily
                SET engagements_executed = engagements_executed + 1,
                    updated_at = now()
                WHERE org_id = $1 AND usage_date = $2
                """,
                org_id,
                today,
            )

            log.info(
                "engagement_quota_consumed",
                org_id=str(org_id),
                plan=plan.plan_key,
                used_after=used + 1,
                daily_limit=plan.daily_engagements,
            )


async def check_and_increment_free_generation_quota(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    today: date,
    generation_type: Literal["post", "image"],
) -> None:
    """
    Free tier quota check for manual post or image generation.

    Locked rules (§C):
      - Either 1 post OR 1 image per day — not both in same day.
      - Each used day counts toward the 15-day monthly cap.

    Raises QuotaExceeded if:
      - The other type was already generated today (mutual exclusion)
      - This type's daily limit is already used
      - Monthly day cap (15 days) is reached
    """
    month_start = today.replace(day=1)

    async with pool.acquire() as conn:
        async with conn.transaction():
            usage_row = await _upsert_and_lock_usage_row(conn, org_id, today)

            if generation_type == "post":
                used_today = usage_row["free_post_generations"]
                other_used_today = usage_row["free_image_generations"]
                other_label = "image"
                col = "free_post_generations"
            else:
                used_today = usage_row["free_image_generations"]
                other_used_today = usage_row["free_post_generations"]
                other_label = "post"
                col = "free_image_generations"

            # Mutual exclusion: post OR image per day, not both
            if other_used_today > 0:
                raise QuotaExceeded(
                    quota_type=f"free_{generation_type}",
                    detail=(
                        f"Free tier allows only one generation per day. "
                        f"You already generated a {other_label} today. "
                        f"Try again tomorrow."
                    ),
                )

            # Daily limit per type
            if used_today >= FREE_DAILY_LIMIT_PER_TYPE:
                raise QuotaExceeded(
                    quota_type=f"free_{generation_type}",
                    detail=f"Free daily {generation_type} generation already used today.",
                )

            # Monthly active-day cap
            monthly_days_used: int = await conn.fetchval(
                """
                SELECT COUNT(DISTINCT usage_date)
                FROM growth.plan_usage_daily
                WHERE org_id = $1
                  AND usage_date >= $2
                  AND (free_post_generations > 0 OR free_image_generations > 0)
                """,
                org_id,
                month_start,
            )

            if monthly_days_used >= FREE_MONTHLY_DAY_CAP:
                raise QuotaExceeded(
                    quota_type=f"free_{generation_type}",
                    detail=(
                        f"Free tier monthly limit reached "
                        f"({monthly_days_used}/{FREE_MONTHLY_DAY_CAP} active days used this month). "
                        "Upgrade to automate more content."
                    ),
                )

            await conn.execute(
                f"""
                UPDATE growth.plan_usage_daily
                SET {col} = {col} + 1, updated_at = now()
                WHERE org_id = $1 AND usage_date = $2
                """,
                org_id,
                today,
            )

            log.info(
                "free_generation_quota_consumed",
                org_id=str(org_id),
                generation_type=generation_type,
                monthly_days_used_after=monthly_days_used + 1,
            )


async def check_and_increment_platform_post_cap(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str,
    today: date,
) -> None:
    """
    Platform safety cap enforcement for publishing.
    Always enforced regardless of content plan tier.

    LinkedIn/Facebook/Instagram: 2 posts/day. X: 8 posts/day.
    Raises QuotaExceeded if the daily platform cap is already hit.
    """
    cap = PLATFORM_POST_CAPS.get(platform)
    if cap is None:
        raise ValueError(f"Unknown platform for cap check: {platform!r}")

    async with pool.acquire() as conn:
        async with conn.transaction():
            counter = await _upsert_and_lock_platform_counter(conn, org_id, platform, today)
            current = counter["posts_published"]

            if current >= cap:
                raise QuotaExceeded(
                    quota_type="platform_post_cap",
                    detail=(
                        f"Platform safety cap reached for {platform}: "
                        f"{current}/{cap} posts published today. Resets at midnight UTC."
                    ),
                )

            await conn.execute(
                """
                UPDATE growth.platform_daily_counters
                SET posts_published = posts_published + 1, updated_at = now()
                WHERE org_id = $1 AND platform = $2 AND counter_date = $3
                """,
                org_id,
                platform,
                today,
            )

            log.info(
                "platform_post_cap_consumed",
                org_id=str(org_id),
                platform=platform,
                used_after=current + 1,
                cap=cap,
            )


async def check_and_increment_platform_engagement_cap(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str,
    today: date,
) -> None:
    """
    Platform engagement safety cap enforcement.
    LinkedIn: 10/day. X: 30/day. Instagram: 10/day.
    Raises QuotaExceeded if cap is already hit.
    """
    cap = PLATFORM_ENGAGEMENT_CAPS.get(platform)
    if cap is None:
        raise ValueError(f"Unknown platform for engagement cap check: {platform!r}")

    async with pool.acquire() as conn:
        async with conn.transaction():
            counter = await _upsert_and_lock_platform_counter(conn, org_id, platform, today)
            current = counter["engagements_executed"]

            if current >= cap:
                raise QuotaExceeded(
                    quota_type="platform_engagement_cap",
                    detail=(
                        f"Platform engagement cap reached for {platform}: "
                        f"{current}/{cap} engagements today. Resets at midnight UTC."
                    ),
                )

            await conn.execute(
                """
                UPDATE growth.platform_daily_counters
                SET engagements_executed = engagements_executed + 1, updated_at = now()
                WHERE org_id = $1 AND platform = $2 AND counter_date = $3
                """,
                org_id,
                platform,
                today,
            )

            log.info(
                "platform_engagement_cap_consumed",
                org_id=str(org_id),
                platform=platform,
                used_after=current + 1,
                cap=cap,
            )


async def get_usage_summary(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    today: date,
) -> dict:
    """
    Return today's usage summary for dashboard display.
    Does NOT acquire a lock — read-only snapshot.
    """
    month_start = today.replace(day=1)

    async with pool.acquire() as conn:
        usage_row = await conn.fetchrow(
            "SELECT * FROM growth.plan_usage_daily WHERE org_id = $1 AND usage_date = $2",
            org_id,
            today,
        )
        settings_row = await conn.fetchrow(
            "SELECT plan_key, engagement_plan_key FROM growth.org_growth_settings WHERE org_id = $1",
            org_id,
        )
        free_days_used: int = await conn.fetchval(
            """
            SELECT COUNT(DISTINCT usage_date)
            FROM growth.plan_usage_daily
            WHERE org_id = $1
              AND usage_date >= $2
              AND (free_post_generations > 0 OR free_image_generations > 0)
            """,
            org_id,
            month_start,
        ) or 0

    plan_key = settings_row["plan_key"] if settings_row else "free"
    engagement_plan_key = settings_row["engagement_plan_key"] if settings_row else None

    content_plan = get_content_plan(plan_key)
    engagement_plan = get_engagement_plan(engagement_plan_key)

    return {
        "date": today.isoformat(),
        "content": {
            "plan": plan_key,
            "daily_limit": content_plan.daily_content_pieces,
            "used_today": usage_row["content_pieces_generated"] if usage_row else 0,
            "can_automate": content_plan.can_automate,
        },
        "free_generation": {
            "posts_today": usage_row["free_post_generations"] if usage_row else 0,
            "images_today": usage_row["free_image_generations"] if usage_row else 0,
            "days_used_this_month": free_days_used,
            "monthly_day_cap": FREE_MONTHLY_DAY_CAP,
        },
        "engagement": {
            "plan": engagement_plan_key,
            "daily_limit": engagement_plan.daily_engagements if engagement_plan else 0,
            "used_today": usage_row["engagements_executed"] if usage_row else 0,
        },
    }
