"""
Engagement plan enforcement — commercial daily caps, platform safety caps.

Commercial plan caps (locked pricing semantics):
  engagement_starter ($99):  5 total billable engagements/day
  engagement_pro    ($199): 15 total billable engagements/day

  One engagement = one AI-generated comment or reply dispatched to platform.
  The commercial cap is a TOTAL, not split by platform or action type.

Platform safety caps (anti-spam, NOT commercial limits):
  LinkedIn: comment 15/day, reply 10/day
  X:        comment  8/day, reply  6/day
  Facebook: comment 10/day
  Instagram: comment 8/day

  These are always higher than the commercial cap and exist solely to prevent
  the org's connected accounts from triggering platform anti-spam systems.

Enforcement order (enforced in check_caps_available):
  1. Commercial total cap  → blocked if org has used ≥ plan limit today
  2. Platform safety cap   → blocked if action exceeds platform anti-spam threshold
  3. Execute

Auto-safe behavior:
  If is_auto_safe(confidence, risk, plan) == True → opportunity set to 'auto_approved'
    → can be executed without human review.
  engagement_starter threshold: confidence >= 0.80, risk < 0.30
  engagement_pro     threshold: confidence >= 0.70, risk < 0.30
  none:                         always False (no plan → no auto-approve)
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Optional

import asyncpg

from app.logging_config import get_logger

log = get_logger(__name__)


# ── Commercial plan total daily caps ─────────────────────────────────────────

_PLAN_TOTAL_DAILY_CAP: dict[str, int] = {
    "engagement_starter": 5,
    "engagement_pro":     15,
}

# ── Platform safety caps ──────────────────────────────────────────────────────
# (platform, action_type) → max per day
_PLATFORM_SAFETY_CAPS: dict[tuple[str, str], int] = {
    ("linkedin",  "comment"): 15,
    ("linkedin",  "reply"):   10,
    ("x",         "comment"):  8,
    ("x",         "reply"):    6,
    ("facebook",  "comment"): 10,
    ("instagram", "comment"):  8,
}

# ── Auto-safe thresholds: (min_confidence, max_risk) ─────────────────────────

_AUTO_SAFE_THRESHOLDS: dict[str, tuple[float, float]] = {
    "engagement_starter": (0.80, 0.30),
    "engagement_pro":     (0.70, 0.30),
}


async def get_org_plan(pool: asyncpg.Pool, org_id: uuid.UUID) -> str:
    """
    Return the org's active engagement plan name.
    Checks org_services for engagement_pro first, then engagement_starter.
    Returns 'none' if neither is active.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT service_key FROM public.org_services
            WHERE org_id = $1
              AND service_key IN ('engagement_pro', 'engagement_starter')
              AND status = 'active'
            ORDER BY
                CASE service_key
                    WHEN 'engagement_pro'     THEN 1
                    WHEN 'engagement_starter' THEN 2
                END
            LIMIT 1
            """,
            org_id,
        )
    plan = row["service_key"] if row else "none"
    log.debug("engagement_plan_resolved", org_id=str(org_id), plan=plan)
    return plan


def get_plan_total_daily_cap(plan: str) -> int:
    """Return the total daily engagement limit for this plan. 0 = no engagements allowed."""
    return _PLAN_TOTAL_DAILY_CAP.get(plan, 0)


def get_platform_safety_cap(platform: str, action_type: str) -> int:
    """Return the platform safety cap for this (platform, action_type). 0 = not supported."""
    return _PLATFORM_SAFETY_CAPS.get((platform, action_type), 0)


def is_auto_safe(
    confidence_score: float,
    risk_score: float,
    plan: str,
) -> bool:
    """
    Return True if this opportunity qualifies for auto-approval (no human review needed).
    Always False when plan='none'.
    """
    thresholds = _AUTO_SAFE_THRESHOLDS.get(plan)
    if not thresholds:
        return False
    min_conf, max_risk = thresholds
    return confidence_score >= min_conf and risk_score < max_risk


async def get_commercial_used_today(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    cap_date: Optional[date] = None,
) -> int:
    """Return today's total billable engagements used (commercial scope)."""
    today = cap_date or date.today()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT count FROM growth.engagement_daily_caps
            WHERE org_id = $1 AND scope = 'commercial'
              AND platform = 'all' AND action_type = 'total'
              AND cap_date = $2
            """,
            org_id, today,
        )
    return row["count"] if row else 0


async def get_safety_used_today(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str,
    action_type: str,
    cap_date: Optional[date] = None,
) -> int:
    """Return today's usage count for a specific platform safety cap."""
    today = cap_date or date.today()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT count FROM growth.engagement_daily_caps
            WHERE org_id = $1 AND scope = 'safety'
              AND platform = $2 AND action_type = $3
              AND cap_date = $4
            """,
            org_id, platform, action_type, today,
        )
    return row["count"] if row else 0


async def check_caps_available(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str,
    action_type: str,
    plan: str,
) -> tuple[bool, str]:
    """
    Two-layer cap check. Returns (allowed, reason).

    Layer 1 — commercial total:
      If org has used >= plan limit today → (False, "commercial_cap_exceeded")
    Layer 2 — platform safety:
      If action_type not supported on platform → (False, "platform_not_supported")
      If safety cap exceeded → (False, "platform_safety_cap_exceeded")
    """
    # Layer 1: commercial total
    total_limit = get_plan_total_daily_cap(plan)
    if total_limit == 0:
        return False, "no_engagement_plan"

    commercial_used = await get_commercial_used_today(pool, org_id)
    if commercial_used >= total_limit:
        return False, f"commercial_cap_exceeded ({commercial_used}/{total_limit})"

    # Layer 2: platform safety
    safety_limit = get_platform_safety_cap(platform, action_type)
    if safety_limit == 0:
        return False, f"platform_action_not_supported ({platform}/{action_type})"

    safety_used = await get_safety_used_today(pool, org_id, platform, action_type)
    if safety_used >= safety_limit:
        return False, f"platform_safety_cap_exceeded ({safety_used}/{safety_limit})"

    return True, "ok"


async def increment_caps(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str,
    action_type: str,
) -> None:
    """
    Increment both the commercial total cap and the platform safety cap by 1.
    Called only on successful execution.
    """
    today = date.today()
    async with pool.acquire() as conn:
        # Commercial total
        await conn.execute(
            """
            INSERT INTO growth.engagement_daily_caps
                (org_id, scope, platform, action_type, cap_date, count)
            VALUES ($1, 'commercial', 'all', 'total', $2, 1)
            ON CONFLICT (org_id, scope, platform, action_type, cap_date)
            DO UPDATE SET count = growth.engagement_daily_caps.count + 1
            """,
            org_id, today,
        )
        # Platform safety
        await conn.execute(
            """
            INSERT INTO growth.engagement_daily_caps
                (org_id, scope, platform, action_type, cap_date, count)
            VALUES ($1, 'safety', $2, $3, $4, 1)
            ON CONFLICT (org_id, scope, platform, action_type, cap_date)
            DO UPDATE SET count = growth.engagement_daily_caps.count + 1
            """,
            org_id, platform, action_type, today,
        )
    log.info("engagement_caps_incremented",
             org_id=str(org_id), platform=platform, action_type=action_type)


async def get_caps_status(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    plan: str,
) -> dict:
    """
    Return full cap status: commercial total + per-platform safety breakdown.
    """
    total_limit = get_plan_total_daily_cap(plan)
    commercial_used = await get_commercial_used_today(pool, org_id) if total_limit > 0 else 0

    safety_rows = []
    for (plat, atype), limit in _PLATFORM_SAFETY_CAPS.items():
        used = await get_safety_used_today(pool, org_id, plat, atype)
        safety_rows.append({
            "platform": plat,
            "action_type": atype,
            "used": used,
            "limit": limit,
            "remaining": max(0, limit - used),
        })

    return {
        "commercial": {
            "used": commercial_used,
            "limit": total_limit,
            "remaining": max(0, total_limit - commercial_used),
        },
        "platform_safety": sorted(safety_rows, key=lambda r: (r["platform"], r["action_type"])),
    }
