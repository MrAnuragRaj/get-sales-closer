"""
Publish error normalizer — maps platform HTTP errors to canonical categories.

Canonical error categories (locked):
  RETRYABLE         — transient: network timeout, 5xx, connection refused
  RATE_LIMITED      — platform quota: 429, LinkedIn throttle, Meta rate codes
  AUTH_FAILED       — token invalid/expired: 401, 403+auth, Meta code 190/102
  APPROVAL_BLOCKED  — internal: variant.status != 'approved' (checked pre-publish)
  CONTENT_REJECTED  — platform content policy: specific 400 codes
  PLATFORM_DISABLED — X called while PLATFORM_X_ENABLED=false
  PERMANENT         — all other non-retryable errors (4xx not covered above)

Platform-specific error code mapping:
  LinkedIn:
    401          → AUTH_FAILED
    403          → AUTH_FAILED (if auth-related message) | PERMANENT
    429          → RATE_LIMITED
    422          → CONTENT_REJECTED
    other 4xx    → PERMANENT
    5xx          → RETRYABLE

  Meta (Facebook/Instagram Graph API):
    error.code 190, 102, 104 → AUTH_FAILED (token expired/invalid)
    error.code 4, 17, 32, 613 → RATE_LIMITED
    error.code 368             → CONTENT_REJECTED (temporarily blocked)
    error.code 100, 200        → PERMANENT (invalid param / permission)
    HTTP 429                   → RATE_LIMITED
    HTTP 401, 403              → AUTH_FAILED
    HTTP 5xx                   → RETRYABLE

Usage:
  category = normalize_error(platform, http_status, response_body)
"""

from __future__ import annotations

from typing import Optional

import httpx

# ── Meta Graph API error codes ─────────────────────────────────────────────────
_META_AUTH_CODES     = frozenset({102, 104, 190, 467, 492})
_META_RATE_CODES     = frozenset({4, 17, 32, 613, 341})
_META_CONTENT_CODES  = frozenset({368, 1404})

# ── LinkedIn error subcode indicators ─────────────────────────────────────────
_LINKEDIN_AUTH_MSG   = frozenset({"invalidtoken", "token", "unauthorized", "expired"})


def normalize_error(
    platform: str,
    http_status: Optional[int],
    response_body: Optional[dict],
    exception: Optional[Exception] = None,
) -> str:
    """
    Map a publish error to a canonical category string.

    Args:
        platform:      "linkedin" | "facebook" | "instagram" | "x"
        http_status:   HTTP response status code (None if no response received)
        response_body: Parsed JSON response body (None if not available)
        exception:     Original exception if the request never completed

    Returns:
        One of: RETRYABLE, RATE_LIMITED, AUTH_FAILED,
                CONTENT_REJECTED, PLATFORM_DISABLED, PERMANENT
    """
    # Network-level failures (no HTTP response received)
    if exception is not None and http_status is None:
        if isinstance(exception, (httpx.TimeoutException, httpx.ConnectError,
                                  httpx.ReadError, httpx.WriteError)):
            return "RETRYABLE"
        return "RETRYABLE"   # treat all network failures as retryable by default

    if http_status is None:
        return "RETRYABLE"

    # 5xx → always retryable regardless of platform
    if http_status >= 500:
        return "RETRYABLE"

    # 429 → rate limited on all platforms
    if http_status == 429:
        return "RATE_LIMITED"

    if platform == "linkedin":
        return _normalize_linkedin(http_status, response_body)

    if platform in ("facebook", "instagram"):
        return _normalize_meta(http_status, response_body)

    if platform == "x":
        return _normalize_x(http_status, response_body)

    # Unknown platform — best-effort
    if http_status == 401:
        return "AUTH_FAILED"
    if http_status == 403:
        return "AUTH_FAILED"
    if 400 <= http_status < 500:
        return "PERMANENT"
    return "RETRYABLE"


def _normalize_linkedin(status: int, body: Optional[dict]) -> str:
    if status == 401:
        return "AUTH_FAILED"

    if status == 403:
        # LinkedIn 403 = permission/scope problem — recoverable after reconnect
        return "AUTH_FAILED"

    if status == 426:
        # LinkedIn 426 "Upgrade Required" = app missing required product
        # (e.g. "Share on LinkedIn" not enabled on the Developer App).
        # Treat as AUTH_FAILED so items go to blocked_auth, not terminal failed.
        return "AUTH_FAILED"

    if status == 422:
        return "CONTENT_REJECTED"

    if status == 429:
        return "RATE_LIMITED"

    if 400 <= status < 500:
        return "PERMANENT"

    return "RETRYABLE"


def _normalize_meta(status: int, body: Optional[dict]) -> str:
    if status in (401, 403):
        return "AUTH_FAILED"

    # Check Graph API error code
    code = _extract_meta_code(body)
    if code is not None:
        if code in _META_AUTH_CODES:
            return "AUTH_FAILED"
        if code in _META_RATE_CODES:
            return "RATE_LIMITED"
        if code in _META_CONTENT_CODES:
            return "CONTENT_REJECTED"

    if status == 400:
        return "PERMANENT"

    if 400 <= status < 500:
        return "PERMANENT"

    return "RETRYABLE"


def _normalize_x(status: int, body: Optional[dict]) -> str:
    if status in (401, 403):
        return "AUTH_FAILED"
    if status == 429:
        return "RATE_LIMITED"
    if status == 400:
        return "PERMANENT"
    if 400 <= status < 500:
        return "PERMANENT"
    return "RETRYABLE"


def _extract_meta_code(body: Optional[dict]) -> Optional[int]:
    """Extract the numeric error code from a Meta Graph API error response."""
    if not body:
        return None
    error = body.get("error", {})
    if isinstance(error, dict):
        code = error.get("code")
        if code is not None:
            try:
                return int(code)
            except (TypeError, ValueError):
                pass
    return None


def _extract_linkedin_message(body: Optional[dict]) -> str:
    """Extract error message string from LinkedIn response."""
    if not body:
        return ""
    return str(body.get("message", body.get("error", "")))


def is_retryable(category: str) -> bool:
    """Return True if this error category should trigger a retry."""
    return category in ("RETRYABLE", "RATE_LIMITED")


def queue_status_for_category(category: str, attempt: int, max_attempts: int) -> str:
    """
    Return the publish_queue status to set for a given error category.

    Schema-valid statuses:
      pending, locked, published, failed,
      blocked_quota, blocked_auth, blocked_approval, cancelled
    """
    if category == "AUTH_FAILED":
        return "blocked_auth"
    if category == "APPROVAL_BLOCKED":
        return "blocked_approval"
    if category == "RATE_LIMITED":
        # Rate limited — retryable until max_attempts
        if attempt >= max_attempts:
            return "failed"
        return "pending"   # re-queued with backoff
    if category == "RETRYABLE":
        if attempt >= max_attempts:
            return "failed"
        return "pending"
    # CONTENT_REJECTED, PERMANENT, PLATFORM_DISABLED, unknown → terminal fail
    return "failed"
