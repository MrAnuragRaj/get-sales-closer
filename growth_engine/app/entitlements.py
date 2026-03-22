"""
Entitlement definitions for Growth Engine plans.

These are the locked product decisions from the build spec.
Do not invent new plan tiers or quota semantics without explicit approval.

──────────────────────────────────────────────────────────────────────────────
LOCKED PLAN SEMANTICS (spec §1.6 + §1.7 + directives §C + §D)
──────────────────────────────────────────────────────────────────────────────

Content posting plans — controls automated content distribution:

    plan_key    Price       Automation  Content pieces/day
    ─────────── ─────────── ─────────── ───────────────────
    "free"      $0          No          0 (manual only, capped at 15 active days/month)
    "starter"   $199/mo     Yes         1
    "growth"    $299/mo     Yes         2
    "scale"     $399/mo     Yes         3

Engagement plans — controls auto-engagement (comments, replies):

    plan_key               Price       Engagements/day  Monthly max
    ────────────────────── ─────────── ──────────────── ───────────
    "engagement_starter"   $99/mo      5                150
    "engagement_pro"       $199/mo     15               450
    None                   —           0 (no plan)      —

Free daily rule (locked directive §C):
    User can generate EITHER 1 post OR 1 image in a day — NOT BOTH.
    Each day on which any free generation occurred counts toward the 15-day
    monthly cap. Days where nothing was generated do NOT count.

Content piece billing rule (locked directive §D):
    1 idea distributed across multiple platforms = 1 content piece.
    Generating LinkedIn + X + Facebook + Instagram variants from one idea
    still counts as 1 content piece, not 4.

Platform safety caps (always enforced — plan tier CANNOT override):
    LinkedIn:  max 2 posts/day, max 10 engagement comments/day
    X:         max 8 posts/day, max 30 replies/day       (design-complete, config-inactive)
    Facebook:  max 2 posts/day, max 10 engagement comments/day
    Instagram: max 2 posts/day, max 10 engagement comments/day

──────────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class ContentPlanEntitlement:
    plan_key: str
    daily_content_pieces: int   # 0 = no automation (free tier)
    can_automate: bool          # False for free tier
    free_generation_days_per_month: int  # 15 for free, 0 for paid


@dataclass(frozen=True)
class EngagementPlanEntitlement:
    plan_key: str
    daily_engagements: int
    monthly_max_engagements: int
    can_auto_engage: bool


# ── Content posting plans ──────────────────────────────────────────────────────
CONTENT_PLANS: dict[str, ContentPlanEntitlement] = {
    "free": ContentPlanEntitlement(
        plan_key="free",
        daily_content_pieces=0,
        can_automate=False,
        free_generation_days_per_month=15,
    ),
    "starter": ContentPlanEntitlement(
        plan_key="starter",
        daily_content_pieces=1,
        can_automate=True,
        free_generation_days_per_month=0,
    ),
    "growth": ContentPlanEntitlement(
        plan_key="growth",
        daily_content_pieces=2,
        can_automate=True,
        free_generation_days_per_month=0,
    ),
    "scale": ContentPlanEntitlement(
        plan_key="scale",
        daily_content_pieces=3,
        can_automate=True,
        free_generation_days_per_month=0,
    ),
}

# ── Engagement plans ───────────────────────────────────────────────────────────
ENGAGEMENT_PLANS: dict[str, EngagementPlanEntitlement] = {
    "engagement_starter": EngagementPlanEntitlement(
        plan_key="engagement_starter",
        daily_engagements=5,
        monthly_max_engagements=150,
        can_auto_engage=True,
    ),
    "engagement_pro": EngagementPlanEntitlement(
        plan_key="engagement_pro",
        daily_engagements=15,
        monthly_max_engagements=450,
        can_auto_engage=True,
    ),
}

# ── Platform safety caps (absolute — plan cannot override) ────────────────────
PLATFORM_POST_CAPS: dict[str, int] = {
    "linkedin": 2,
    "x": 8,
    "facebook": 2,
    "instagram": 2,
}

PLATFORM_ENGAGEMENT_CAPS: dict[str, int] = {
    "linkedin": 10,
    "x": 30,
    "facebook": 10,
    "instagram": 10,
}

# ── Free tier constants ────────────────────────────────────────────────────────
FREE_DAILY_LIMIT_PER_TYPE: int = 1   # 1 post OR 1 image per day (not both)
FREE_MONTHLY_DAY_CAP: int = 15       # calendar days per month


# ── Lookup helpers ─────────────────────────────────────────────────────────────
def get_content_plan(plan_key: str) -> ContentPlanEntitlement:
    plan = CONTENT_PLANS.get(plan_key)
    if plan is None:
        raise ValueError(
            f"Unknown content plan key: {plan_key!r}. "
            f"Valid keys: {list(CONTENT_PLANS)}"
        )
    return plan


def get_engagement_plan(plan_key: Optional[str]) -> Optional[EngagementPlanEntitlement]:
    """Returns None if plan_key is None (org has no engagement plan)."""
    if not plan_key:
        return None
    plan = ENGAGEMENT_PLANS.get(plan_key)
    if plan is None:
        raise ValueError(
            f"Unknown engagement plan key: {plan_key!r}. "
            f"Valid keys: {list(ENGAGEMENT_PLANS)}"
        )
    return plan
