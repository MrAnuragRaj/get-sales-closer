"""
Tests for free-tier quota logic and X platform dormant behavior.

These tests do NOT require a live database connection.
The asyncpg pool is mocked to control the exact DB state returned.

Free-tier rules under test (locked spec §1.5, directive §C):
  Rule 1 — Mutual exclusion: post OR image per day, never both.
  Rule 2 — Daily limit: only 1 of whichever type per day.
  Rule 3 — Monthly day cap: after 15 used days, all free generation is blocked.
  Rule 4 — Unused days do not count toward the monthly cap.

X dormant rules under test (locked spec §1.5):
  Rule 5 — X architecture is present (caps defined) but execution is config-disabled.
  Rule 6 — Service does not require X credentials when PLATFORM_X_ENABLED=false.
  Rule 7 — Disabling X leaves LinkedIn/Facebook/Instagram unaffected.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from datetime import date
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.entitlements import (
    FREE_MONTHLY_DAY_CAP,
    PLATFORM_POST_CAPS,
    get_content_plan,
    get_engagement_plan,
)
from app.quotas import QuotaExceeded, check_and_increment_free_generation_quota

ORG_ID = uuid.uuid4()
TODAY = date(2026, 3, 12)


# ── Pool mock factory ──────────────────────────────────────────────────────────

def _make_pool(
    free_post_today: int = 0,
    free_image_today: int = 0,
    monthly_days_used: int = 0,
) -> MagicMock:
    """
    Build a mock asyncpg pool that presents the given DB state.

    fetchrow  → returns the plan_usage_daily usage row.
    fetchval  → returns monthly_days_used count.
    execute   → accepts INSERT (upsert) and UPDATE calls silently.
    """
    usage_row = {
        "free_post_generations": free_post_today,
        "free_image_generations": free_image_today,
        "content_pieces_generated": 0,
        "engagements_executed": 0,
    }

    conn = AsyncMock()
    conn.execute = AsyncMock(return_value=None)
    conn.fetchrow = AsyncMock(return_value=usage_row)
    conn.fetchval = AsyncMock(return_value=monthly_days_used)

    # conn.transaction() is used as an async context manager
    tx_ctx = MagicMock()
    tx_ctx.__aenter__ = AsyncMock(return_value=None)
    tx_ctx.__aexit__ = AsyncMock(return_value=False)
    conn.transaction = MagicMock(return_value=tx_ctx)

    # pool.acquire() is used as an async context manager
    acquire_ctx = MagicMock()
    acquire_ctx.__aenter__ = AsyncMock(return_value=conn)
    acquire_ctx.__aexit__ = AsyncMock(return_value=False)

    pool = MagicMock()
    pool.acquire = MagicMock(return_value=acquire_ctx)
    return pool


# ── Rule 1: Mutual exclusion — post → image blocked ───────────────────────────

def test_post_then_image_same_day_is_blocked():
    """
    If a post was already generated today, attempting an image is blocked.
    free_post_today=1 means a post was used. generation_type='image' → other_used_today=1.
    """
    pool = _make_pool(free_post_today=1, free_image_today=0)
    with pytest.raises(QuotaExceeded) as exc_info:
        asyncio.get_event_loop().run_until_complete(
            check_and_increment_free_generation_quota(pool, ORG_ID, TODAY, "image")
        )
    assert exc_info.value.quota_type == "free_image"
    assert "post" in exc_info.value.detail.lower()
    assert "already generated" in exc_info.value.detail.lower()


# ── Rule 1: Mutual exclusion — image → post blocked ───────────────────────────

def test_image_then_post_same_day_is_blocked():
    """
    If an image was already generated today, attempting a post is blocked.
    free_image_today=1 means an image was used. generation_type='post' → other_used_today=1.
    """
    pool = _make_pool(free_post_today=0, free_image_today=1)
    with pytest.raises(QuotaExceeded) as exc_info:
        asyncio.get_event_loop().run_until_complete(
            check_and_increment_free_generation_quota(pool, ORG_ID, TODAY, "post")
        )
    assert exc_info.value.quota_type == "free_post"
    assert "image" in exc_info.value.detail.lower()
    assert "already generated" in exc_info.value.detail.lower()


# ── Rule 2: Daily limit — already used today ──────────────────────────────────

def test_post_already_used_today_is_blocked():
    """
    If a post was already generated today (same type), it's blocked by daily limit.
    Note: this case is only reached when other_type is 0 (mutual exclusion didn't fire).
    Simulates a scenario where free_post_today=1 but free_image_today=0 and type='post'.
    This cannot naturally occur (generation_type='post' and free_post_today=1 means
    the limit of 1 is already consumed for that type) — verifies the counter check.
    """
    pool = _make_pool(free_post_today=1, free_image_today=0)
    # Attempting post again — other (image) is 0, so mutual exclusion won't fire.
    # But used_today (post) == FREE_DAILY_LIMIT_PER_TYPE (1), so it blocks on limit.
    with pytest.raises(QuotaExceeded) as exc_info:
        asyncio.get_event_loop().run_until_complete(
            check_and_increment_free_generation_quota(pool, ORG_ID, TODAY, "post")
        )
    # Either mutual exclusion or daily limit fires — either is correct.
    # (In this case: other_used=0, so mutual exclusion doesn't fire,
    #  used_today=1 >= FREE_DAILY_LIMIT_PER_TYPE=1, daily limit fires.)
    assert exc_info.value.quota_type == "free_post"


# ── Rule 3: Monthly cap — 15th day used, 16th blocked ─────────────────────────

def test_monthly_day_cap_blocks_on_16th_used_day():
    """
    After FREE_MONTHLY_DAY_CAP (15) days are used, the next generation is blocked.
    monthly_days_used=15 with a fresh day (no usage today) → blocked.
    """
    pool = _make_pool(free_post_today=0, free_image_today=0, monthly_days_used=15)
    with pytest.raises(QuotaExceeded) as exc_info:
        asyncio.get_event_loop().run_until_complete(
            check_and_increment_free_generation_quota(pool, ORG_ID, TODAY, "post")
        )
    assert exc_info.value.quota_type == "free_post"
    assert "15" in exc_info.value.detail
    assert "month" in exc_info.value.detail.lower()


def test_exactly_at_monthly_cap_is_blocked():
    """Boundary: monthly_days_used == FREE_MONTHLY_DAY_CAP is blocked."""
    assert FREE_MONTHLY_DAY_CAP == 15
    pool = _make_pool(monthly_days_used=FREE_MONTHLY_DAY_CAP)
    with pytest.raises(QuotaExceeded) as exc_info:
        asyncio.get_event_loop().run_until_complete(
            check_and_increment_free_generation_quota(pool, ORG_ID, TODAY, "post")
        )
    assert exc_info.value.quota_type == "free_post"


# ── Rule 4: Unused days do not count ──────────────────────────────────────────

def test_first_use_of_month_is_allowed():
    """
    A user who has never generated anything this month (monthly_days_used=0)
    can generate a post today.
    """
    pool = _make_pool(free_post_today=0, free_image_today=0, monthly_days_used=0)
    # Should not raise — execute (UPDATE counter) is called
    asyncio.get_event_loop().run_until_complete(
        check_and_increment_free_generation_quota(pool, ORG_ID, TODAY, "post")
    )
    pool.acquire().__aenter__.return_value.execute.assert_called()


def test_14_days_used_still_allowed():
    """14 used days (below cap of 15) allows one more generation."""
    pool = _make_pool(free_post_today=0, free_image_today=0, monthly_days_used=14)
    asyncio.get_event_loop().run_until_complete(
        check_and_increment_free_generation_quota(pool, ORG_ID, TODAY, "post")
    )
    # No exception = passed


# ── Rule 5: X architecture present but config-disabled ────────────────────────

def test_x_platform_caps_are_architecturally_defined():
    """
    X adapter/caps must exist in the codebase (design-complete).
    They are NOT active by default — this confirms architecture without activation.
    """
    assert "x" in PLATFORM_POST_CAPS, "X must have a platform post cap defined"
    assert PLATFORM_POST_CAPS["x"] == 8

    from app.entitlements import PLATFORM_ENGAGEMENT_CAPS
    assert "x" in PLATFORM_ENGAGEMENT_CAPS
    assert PLATFORM_ENGAGEMENT_CAPS["x"] == 30


# ── Rule 6: PLATFORM_X_ENABLED=false → no X credentials required ─────────────

def test_x_disabled_service_does_not_require_x_credentials():
    """
    When PLATFORM_X_ENABLED=false, the service must start cleanly
    without X_API_KEY, X_API_SECRET, or X_BEARER_TOKEN.
    """
    # Remove X credentials from env if present
    for key in ("X_API_KEY", "X_API_SECRET", "X_BEARER_TOKEN"):
        os.environ.pop(key, None)

    os.environ["PLATFORM_X_ENABLED"] = "false"
    os.environ["GROWTH_ENCRYPTION_KEY"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    os.environ["DATABASE_URL"] = "postgresql://test:test@localhost/test"
    os.environ["SUPABASE_JWT_SECRET"] = "test_secret"

    # Config must load without error and report X as disabled
    from app.config import get_settings
    get_settings.cache_clear()
    settings = get_settings()

    assert settings.platform_x_enabled is False
    assert settings.x_api_key == ""
    assert "x" not in settings.enabled_platforms()
    assert "linkedin" in settings.enabled_platforms()

    # Cleanup
    get_settings.cache_clear()


# ── Rule 7: X disabled leaves other platforms unaffected ─────────────────────

def test_x_disabled_does_not_affect_other_platforms():
    """LinkedIn, Facebook, Instagram remain active when X is disabled."""
    os.environ["PLATFORM_X_ENABLED"] = "false"
    os.environ["PLATFORM_LINKEDIN_ENABLED"] = "true"
    os.environ["PLATFORM_FACEBOOK_ENABLED"] = "true"
    os.environ["PLATFORM_INSTAGRAM_ENABLED"] = "true"
    os.environ["GROWTH_ENCRYPTION_KEY"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    os.environ["DATABASE_URL"] = "postgresql://test:test@localhost/test"
    os.environ["SUPABASE_JWT_SECRET"] = "test_secret"

    from app.config import get_settings
    get_settings.cache_clear()
    settings = get_settings()

    active = settings.enabled_platforms()
    assert "linkedin" in active
    assert "facebook" in active
    assert "instagram" in active
    assert "x" not in active

    get_settings.cache_clear()
