"""
Tests for the publish queue worker state machine, retry policy,
error normalization, and stale lock recovery.

All DB calls are mocked — no live DB required.

Run via: pytest tests/test_publish_worker.py
Requires: pytest-asyncio (in requirements.txt)
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ── Helpers ─────────────────────────────────────────────────────────────────────

def _make_item(**overrides) -> dict:
    base = {
        "id": uuid.uuid4(),
        "org_id": uuid.uuid4(),
        "platform": "linkedin",
        "variant_id": uuid.uuid4(),
        "asset_id": None,
        "idempotency_key": "test-ikey",
        "attempt_count": 1,
        "max_attempts": 5,
        "scheduled_for": datetime.now(timezone.utc),
    }
    base.update(overrides)
    return base


def _make_pool() -> tuple:
    conn = AsyncMock()
    conn.fetchrow = AsyncMock(return_value=None)
    conn.fetch = AsyncMock(return_value=[])
    conn.execute = AsyncMock(return_value="UPDATE 1")

    pool = MagicMock()
    pool.acquire = MagicMock()
    pool.acquire.return_value.__aenter__ = AsyncMock(return_value=conn)
    pool.acquire.return_value.__aexit__ = AsyncMock(return_value=False)
    return pool, conn


# ── Error normalization ─────────────────────────────────────────────────────────

class TestNormalizeError:
    def test_5xx_always_retryable(self):
        from app.publishers.error_normalizer import normalize_error
        for status in (500, 502, 503, 504):
            assert normalize_error("linkedin", status, {}) == "RETRYABLE"
            assert normalize_error("facebook", status, {}) == "RETRYABLE"

    def test_429_rate_limited_all_platforms(self):
        from app.publishers.error_normalizer import normalize_error
        for platform in ("linkedin", "facebook", "instagram", "x"):
            assert normalize_error(platform, 429, {}) == "RATE_LIMITED"

    def test_network_error_retryable(self):
        import httpx
        from app.publishers.error_normalizer import normalize_error
        exc = httpx.ConnectError("connection refused")
        assert normalize_error("linkedin", None, None, exception=exc) == "RETRYABLE"

    def test_linkedin_401_auth_failed(self):
        from app.publishers.error_normalizer import normalize_error
        assert normalize_error("linkedin", 401, {}) == "AUTH_FAILED"

    def test_linkedin_422_content_rejected(self):
        from app.publishers.error_normalizer import normalize_error
        assert normalize_error("linkedin", 422, {}) == "CONTENT_REJECTED"

    def test_linkedin_403_with_token_message_auth_failed(self):
        from app.publishers.error_normalizer import normalize_error
        body = {"message": "token expired or invalid"}
        assert normalize_error("linkedin", 403, body) == "AUTH_FAILED"

    def test_linkedin_403_without_auth_message_permanent(self):
        from app.publishers.error_normalizer import normalize_error
        body = {"message": "insufficient permissions"}
        assert normalize_error("linkedin", 403, body) == "PERMANENT"

    def test_meta_auth_code_190(self):
        from app.publishers.error_normalizer import normalize_error
        body = {"error": {"code": 190, "message": "token expired"}}
        assert normalize_error("facebook", 400, body) == "AUTH_FAILED"

    def test_meta_auth_code_102(self):
        from app.publishers.error_normalizer import normalize_error
        body = {"error": {"code": 102, "message": "session invalidated"}}
        assert normalize_error("instagram", 400, body) == "AUTH_FAILED"

    def test_meta_rate_code_17(self):
        from app.publishers.error_normalizer import normalize_error
        body = {"error": {"code": 17, "message": "rate limit"}}
        assert normalize_error("facebook", 400, body) == "RATE_LIMITED"

    def test_meta_rate_code_613(self):
        from app.publishers.error_normalizer import normalize_error
        body = {"error": {"code": 613}}
        assert normalize_error("instagram", 400, body) == "RATE_LIMITED"

    def test_meta_content_code_368(self):
        from app.publishers.error_normalizer import normalize_error
        body = {"error": {"code": 368, "message": "policy violation"}}
        assert normalize_error("facebook", 400, body) == "CONTENT_REJECTED"

    def test_meta_401_auth_failed(self):
        from app.publishers.error_normalizer import normalize_error
        assert normalize_error("facebook", 401, {}) == "AUTH_FAILED"

    def test_x_401_auth_failed(self):
        from app.publishers.error_normalizer import normalize_error
        assert normalize_error("x", 401, {}) == "AUTH_FAILED"

    def test_x_400_permanent(self):
        from app.publishers.error_normalizer import normalize_error
        assert normalize_error("x", 400, {}) == "PERMANENT"

    def test_no_http_status_retryable(self):
        from app.publishers.error_normalizer import normalize_error
        assert normalize_error("linkedin", None, None) == "RETRYABLE"


# ── queue_status_for_category ───────────────────────────────────────────────────

class TestQueueStatusForCategory:
    def test_auth_failed_blocked_auth(self):
        from app.publishers.error_normalizer import queue_status_for_category
        assert queue_status_for_category("AUTH_FAILED", 1, 5) == "blocked_auth"

    def test_approval_blocked(self):
        from app.publishers.error_normalizer import queue_status_for_category
        assert queue_status_for_category("APPROVAL_BLOCKED", 1, 5) == "blocked_approval"

    def test_retryable_below_max_pending(self):
        from app.publishers.error_normalizer import queue_status_for_category
        assert queue_status_for_category("RETRYABLE", 1, 5) == "pending"
        assert queue_status_for_category("RETRYABLE", 4, 5) == "pending"

    def test_retryable_at_max_failed(self):
        from app.publishers.error_normalizer import queue_status_for_category
        assert queue_status_for_category("RETRYABLE", 5, 5) == "failed"

    def test_rate_limited_below_max_pending(self):
        from app.publishers.error_normalizer import queue_status_for_category
        assert queue_status_for_category("RATE_LIMITED", 2, 5) == "pending"

    def test_rate_limited_at_max_failed(self):
        from app.publishers.error_normalizer import queue_status_for_category
        assert queue_status_for_category("RATE_LIMITED", 5, 5) == "failed"

    def test_content_rejected_failed(self):
        from app.publishers.error_normalizer import queue_status_for_category
        assert queue_status_for_category("CONTENT_REJECTED", 1, 5) == "failed"

    def test_permanent_failed(self):
        from app.publishers.error_normalizer import queue_status_for_category
        assert queue_status_for_category("PERMANENT", 1, 5) == "failed"

    def test_platform_disabled_failed(self):
        from app.publishers.error_normalizer import queue_status_for_category
        assert queue_status_for_category("PLATFORM_DISABLED", 1, 5) == "failed"


# ── Retry policy ─────────────────────────────────────────────────────────────────

class TestRetryPolicy:
    def test_retryable_should_retry_below_max(self):
        from app.publishers.retry_policy import should_retry
        for attempt in range(1, 5):
            assert should_retry("RETRYABLE", attempt) is True

    def test_retryable_no_retry_at_max(self):
        from app.publishers.retry_policy import should_retry
        assert should_retry("RETRYABLE", 5) is False

    def test_rate_limited_should_retry_below_max(self):
        from app.publishers.retry_policy import should_retry
        assert should_retry("RATE_LIMITED", 1) is True
        assert should_retry("RATE_LIMITED", 4) is True

    def test_rate_limited_no_retry_at_max(self):
        from app.publishers.retry_policy import should_retry
        assert should_retry("RATE_LIMITED", 5) is False

    def test_permanent_never_retries(self):
        from app.publishers.retry_policy import should_retry
        assert should_retry("PERMANENT", 1) is False

    def test_auth_failed_never_retries(self):
        from app.publishers.retry_policy import should_retry
        assert should_retry("AUTH_FAILED", 1) is False

    def test_retryable_backoff_exponential(self):
        from app.publishers.retry_policy import backoff_seconds
        assert backoff_seconds("RETRYABLE", 1) == 120    # 2^1 * 60
        assert backoff_seconds("RETRYABLE", 2) == 240    # 2^2 * 60
        assert backoff_seconds("RETRYABLE", 3) == 480    # 2^3 * 60
        assert backoff_seconds("RETRYABLE", 4) == 960    # 2^4 * 60

    def test_retryable_backoff_capped_at_3600(self):
        from app.publishers.retry_policy import backoff_seconds
        assert backoff_seconds("RETRYABLE", 10) == 3600

    def test_rate_limited_backoff(self):
        from app.publishers.retry_policy import backoff_seconds
        assert backoff_seconds("RATE_LIMITED", 1) == 600   # 2^1 * 300
        assert backoff_seconds("RATE_LIMITED", 2) == 1200  # 2^2 * 300

    def test_rate_limited_backoff_capped_at_14400(self):
        from app.publishers.retry_policy import backoff_seconds
        assert backoff_seconds("RATE_LIMITED", 10) == 14400

    def test_non_retryable_backoff_zero(self):
        from app.publishers.retry_policy import backoff_seconds
        assert backoff_seconds("PERMANENT", 1) == 0
        assert backoff_seconds("AUTH_FAILED", 1) == 0

    def test_next_scheduled_for_is_future(self):
        from app.publishers.retry_policy import next_scheduled_for
        now = datetime.now(timezone.utc)
        scheduled = next_scheduled_for("RETRYABLE", 1)
        assert scheduled > now


# ── State machine (worker) ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_idempotency_skips_api_call():
    """
    If publish_logs already has a success row, transition to published
    without calling the platform API.
    """
    from app.services.queue_worker import execute_queue_item

    pool, conn = _make_pool()
    conn.fetchrow.return_value = {"id": uuid.uuid4()}  # already published

    item = _make_item()
    transition_mock = AsyncMock()

    with patch("app.services.queue_worker._transition", transition_mock):
        await execute_queue_item(pool, item)

    transition_mock.assert_called_once()
    assert transition_mock.call_args.args[2] == "published"


@pytest.mark.asyncio
async def test_variant_not_approved_blocks():
    """
    If variant.status is not approved/force_approved, transition to blocked_approval.
    """
    from app.services.queue_worker import execute_queue_item

    pool, conn = _make_pool()
    item = _make_item()
    conn.fetchrow.side_effect = [
        None,  # _already_published → not found
        {
            "id": item["variant_id"],
            "status": "draft",
            "body_text": "x",
            "caption_text": None,
            "platform": "linkedin",
        },
    ]

    transition_mock = AsyncMock()
    with patch("app.services.queue_worker._transition", transition_mock):
        await execute_queue_item(pool, item)

    assert transition_mock.call_args.args[2] == "blocked_approval"


@pytest.mark.asyncio
async def test_no_account_blocks_auth():
    """
    If resolve_account returns None, transition to blocked_auth.
    """
    from app.services.queue_worker import execute_queue_item

    pool, conn = _make_pool()
    item = _make_item()
    conn.fetchrow.side_effect = [
        None,
        {
            "id": item["variant_id"],
            "status": "approved",
            "body_text": "body",
            "caption_text": None,
            "platform": "linkedin",
        },
    ]

    transition_mock = AsyncMock()
    with patch("app.services.queue_worker._transition", transition_mock), \
         patch("app.services.queue_worker.resolve_account", AsyncMock(return_value=None)):
        await execute_queue_item(pool, item)

    assert transition_mock.call_args.args[2] == "blocked_auth"


@pytest.mark.asyncio
async def test_successful_publish_transitions_to_published():
    """
    A successful publish result should transition to published
    and call _finalize_variant.
    """
    from app.publishers.base import PublishResult
    from app.services.queue_worker import execute_queue_item

    pool, conn = _make_pool()
    item = _make_item()
    conn.fetchrow.side_effect = [
        None,
        {
            "id": item["variant_id"],
            "status": "approved",
            "body_text": "body",
            "caption_text": None,
            "platform": "linkedin",
        },
    ]

    account = {"platform_account_id": "urn:li:person:X", "access_token": "tok"}
    success_result = PublishResult(
        success=True,
        platform_post_id="urn:li:share:99",
        platform_post_url="https://linkedin.com/feed/update/urn:li:share:99",
        http_status=201,
    )

    transition_mock = AsyncMock()
    finalize_mock = AsyncMock()
    write_log_mock = AsyncMock()

    with patch("app.services.queue_worker.resolve_account", AsyncMock(return_value=account)), \
         patch("app.services.queue_worker._resolve_asset_url", AsyncMock(return_value=None)), \
         patch("app.services.queue_worker._PUBLISHERS",
               {"linkedin": MagicMock(publish=AsyncMock(return_value=success_result))}), \
         patch("app.services.queue_worker._write_publish_log", write_log_mock), \
         patch("app.services.queue_worker._finalize_variant", finalize_mock), \
         patch("app.services.queue_worker._transition", transition_mock):
        await execute_queue_item(pool, item)

    finalize_mock.assert_called_once_with(pool, item["variant_id"])
    assert transition_mock.call_args.args[2] == "published"
    write_log_mock.assert_called_once()


@pytest.mark.asyncio
async def test_retryable_error_below_max_requeues():
    """
    RETRYABLE error at attempt 1 (of 5) should put item back to pending with backoff.
    """
    from app.publishers.base import PublishResult
    from app.services.queue_worker import execute_queue_item

    pool, conn = _make_pool()
    item = _make_item(attempt_count=1, max_attempts=5)
    conn.fetchrow.side_effect = [
        None,
        {"id": item["variant_id"], "status": "approved",
         "body_text": "body", "caption_text": None, "platform": "linkedin"},
    ]

    fail_result = PublishResult(
        success=False,
        error_category="RETRYABLE",
        error_message="server error",
        http_status=503,
    )
    account = {"platform_account_id": "urn:li:person:X", "access_token": "tok"}
    transition_mock = AsyncMock()

    with patch("app.services.queue_worker.resolve_account", AsyncMock(return_value=account)), \
         patch("app.services.queue_worker._resolve_asset_url", AsyncMock(return_value=None)), \
         patch("app.services.queue_worker._PUBLISHERS",
               {"linkedin": MagicMock(publish=AsyncMock(return_value=fail_result))}), \
         patch("app.services.queue_worker._write_publish_log", AsyncMock()), \
         patch("app.services.queue_worker._transition", transition_mock):
        await execute_queue_item(pool, item)

    assert transition_mock.call_args.args[2] == "pending"
    assert "scheduled_for" in transition_mock.call_args.kwargs


@pytest.mark.asyncio
async def test_retryable_at_max_attempts_fails():
    """
    RETRYABLE error at attempt 5 (of 5) should transition to failed.
    """
    from app.publishers.base import PublishResult
    from app.services.queue_worker import execute_queue_item

    pool, conn = _make_pool()
    item = _make_item(attempt_count=5, max_attempts=5)
    conn.fetchrow.side_effect = [
        None,
        {"id": item["variant_id"], "status": "approved",
         "body_text": "body", "caption_text": None, "platform": "linkedin"},
    ]

    fail_result = PublishResult(
        success=False,
        error_category="RETRYABLE",
        error_message="still failing",
        http_status=500,
    )
    account = {"platform_account_id": "urn:li:person:X", "access_token": "tok"}
    transition_mock = AsyncMock()

    with patch("app.services.queue_worker.resolve_account", AsyncMock(return_value=account)), \
         patch("app.services.queue_worker._resolve_asset_url", AsyncMock(return_value=None)), \
         patch("app.services.queue_worker._PUBLISHERS",
               {"linkedin": MagicMock(publish=AsyncMock(return_value=fail_result))}), \
         patch("app.services.queue_worker._write_publish_log", AsyncMock()), \
         patch("app.services.queue_worker._transition", transition_mock):
        await execute_queue_item(pool, item)

    assert transition_mock.call_args.args[2] == "failed"


@pytest.mark.asyncio
async def test_stale_lock_reset():
    """
    reset_stale_locks should run an UPDATE and return count.
    """
    from app.services.queue_worker import reset_stale_locks

    pool, conn = _make_pool()
    conn.execute.return_value = "UPDATE 3"

    count = await reset_stale_locks(pool)
    assert count == 3
    conn.execute.assert_called_once()
    sql = conn.execute.call_args.args[0]
    assert "locked_until" in sql
    assert "pending" in sql


@pytest.mark.asyncio
async def test_unknown_platform_fails():
    """
    A queue item with an unknown platform should transition to failed immediately.
    """
    from app.services.queue_worker import execute_queue_item

    pool, conn = _make_pool()
    item = _make_item(platform="tiktok")
    conn.fetchrow.side_effect = [
        None,
        {"id": item["variant_id"], "status": "approved",
         "body_text": "body", "caption_text": None, "platform": "tiktok"},
    ]

    account = {"platform_account_id": "tiktok_id", "access_token": "tok"}
    transition_mock = AsyncMock()

    with patch("app.services.queue_worker.resolve_account", AsyncMock(return_value=account)), \
         patch("app.services.queue_worker._resolve_asset_url", AsyncMock(return_value=None)), \
         patch("app.services.queue_worker._transition", transition_mock):
        await execute_queue_item(pool, item)

    assert transition_mock.call_args.args[2] == "failed"


@pytest.mark.asyncio
async def test_content_rejected_transitions_to_failed():
    """
    CONTENT_REJECTED is terminal — should go to failed regardless of attempt count.
    """
    from app.publishers.base import PublishResult
    from app.services.queue_worker import execute_queue_item

    pool, conn = _make_pool()
    item = _make_item(attempt_count=1, max_attempts=5)
    conn.fetchrow.side_effect = [
        None,
        {"id": item["variant_id"], "status": "approved",
         "body_text": "body", "caption_text": None, "platform": "instagram"},
    ]

    reject_result = PublishResult(
        success=False,
        error_category="CONTENT_REJECTED",
        error_message="policy violation",
        http_status=400,
    )
    account = {"platform_account_id": "ig_user_123", "access_token": "tok"}
    transition_mock = AsyncMock()

    with patch("app.services.queue_worker.resolve_account", AsyncMock(return_value=account)), \
         patch("app.services.queue_worker._resolve_asset_url", AsyncMock(return_value="https://img.png")), \
         patch("app.services.queue_worker._PUBLISHERS",
               {"instagram": MagicMock(publish=AsyncMock(return_value=reject_result))}), \
         patch("app.services.queue_worker._write_publish_log", AsyncMock()), \
         patch("app.services.queue_worker._transition", transition_mock):
        await execute_queue_item(pool, item)

    assert transition_mock.call_args.args[2] == "failed"
