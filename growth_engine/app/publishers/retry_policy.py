"""
Retry policy — backoff delays per error category.

Rules (locked):
  RETRYABLE    — yes, max 5 attempts, exponential: min(2^n * 60s, 3600s)
  RATE_LIMITED — yes, max 5 attempts, exponential: min(2^n * 300s, 14400s)
  AUTH_FAILED       — no retry; transitions to blocked_auth
  APPROVAL_BLOCKED  — no retry; transitions to blocked_approval
  CONTENT_REJECTED  — no retry; transitions to failed
  PLATFORM_DISABLED — no retry; transitions to failed
  PERMANENT         — no retry; transitions to failed

Backoff examples:
  RETRYABLE attempt 1: 60s    RETRYABLE attempt 2: 120s
  RETRYABLE attempt 3: 240s   RETRYABLE attempt 4: 480s
  RETRYABLE attempt 5: 960s (capped to 60 min in practice — last attempt before failure)

  RATE_LIMITED attempt 1: 300s (5 min)
  RATE_LIMITED attempt 2: 600s (10 min)
  RATE_LIMITED attempt 3: 1200s (20 min)
  RATE_LIMITED attempt 4: 2400s (40 min)
  RATE_LIMITED attempt 5: 4800s → capped to 14400s (4h)

attempt is 1-indexed (first publish = attempt 1).
backoff_seconds() is called AFTER failure to determine next scheduled_for.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional

MAX_ATTEMPTS_DEFAULT = 5

# (should_retry, max_attempts)
_RETRY_RULES: dict[str, tuple[bool, int]] = {
    "RETRYABLE":        (True,  5),
    "RATE_LIMITED":     (True,  5),
    "AUTH_FAILED":      (False, 1),
    "APPROVAL_BLOCKED": (False, 1),
    "CONTENT_REJECTED": (False, 1),
    "PLATFORM_DISABLED":(False, 1),
    "PERMANENT":        (False, 1),
}

# Caps in seconds
_RETRYABLE_MAX_DELAY   = 3600    # 1 hour
_RATE_LIMITED_MAX_DELAY= 14400   # 4 hours


def should_retry(category: str, attempt: int) -> bool:
    """
    Return True if the queue item should be retried after this failure.

    Args:
        category: canonical error category
        attempt:  1-indexed attempt number that just failed
    """
    retryable, max_attempts = _RETRY_RULES.get(category, (False, 1))
    return retryable and attempt < max_attempts


def backoff_seconds(category: str, attempt: int) -> int:
    """
    Calculate delay in seconds before the next attempt.

    Args:
        category: canonical error category
        attempt:  1-indexed attempt number that just failed

    Returns:
        Delay in seconds. Returns 0 for non-retryable categories
        (though should_retry() would return False for those).
    """
    if category == "RETRYABLE":
        return min(2 ** attempt * 60, _RETRYABLE_MAX_DELAY)
    if category == "RATE_LIMITED":
        return min(2 ** attempt * 300, _RATE_LIMITED_MAX_DELAY)
    return 0


def next_scheduled_for(category: str, attempt: int) -> datetime:
    """Return the next scheduled_for timestamp for a failed-but-retryable item."""
    delay = backoff_seconds(category, attempt)
    return datetime.now(timezone.utc) + timedelta(seconds=delay)


def max_attempts_for(category: str) -> int:
    """Return the maximum number of attempts for a category."""
    _, max_att = _RETRY_RULES.get(category, (False, 1))
    return max_att
