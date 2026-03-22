"""
X (Twitter) engagement executor — feature-disabled in v1.

X engagement is architected but inactive. The full implementation is deferred
until PLATFORM_X_ENABLED is set to true and X OAuth credentials are configured.

This adapter always returns PLATFORM_DISABLED with no API call made.
No network requests, no token usage, no side effects.

Activation path (when ready):
  1. Set PLATFORM_X_ENABLED=true in environment
  2. Configure X_API_KEY, X_API_SECRET, X_BEARER_TOKEN
  3. Replace the stub in execute_x_engagement with real Twitter API v2 calls:
     POST https://api.twitter.com/2/tweets   (with reply.in_reply_to_tweet_id for reply)
  4. Required OAuth scope: tweet.write
  5. Update capability.py to evaluate X engage_capable from token + scopes

Return type: EngagementResult (same dataclass as other adapters)
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Optional

from app.config import settings
from app.logging_config import get_logger

log = get_logger(__name__)

_DISABLED_MESSAGE = (
    "X engagement is not active in v1. "
    "Set PLATFORM_X_ENABLED=true and configure X credentials to enable."
)


@dataclass
class EngagementResult:
    success:            bool
    platform_action_id: Optional[str] = None
    error_category:     Optional[str] = None
    error_message:      Optional[str] = None
    http_status:        Optional[int] = None


async def execute_x_engagement(
    pool,
    org_id: uuid.UUID,
    platform: str,          # always "x"
    post_platform_id: str,
    action_text: str,
    action_type: str,
) -> EngagementResult:
    """
    X engagement dispatcher.

    While PLATFORM_X_ENABLED=false: always returns PLATFORM_DISABLED, no API call.
    When activated: will dispatch to real Twitter API v2 implementation.
    """
    if not settings.platform_x_enabled:
        log.debug(
            "x_engagement_platform_disabled",
            org_id=str(org_id), action_type=action_type,
        )
        return EngagementResult(
            success=False,
            error_category="PLATFORM_DISABLED",
            error_message=_DISABLED_MESSAGE,
        )

    # ── Placeholder for future real implementation ─────────────────────────
    # When PLATFORM_X_ENABLED=true, implement:
    #   POST https://api.twitter.com/2/tweets
    #   {"text": action_text, "reply": {"in_reply_to_tweet_id": post_platform_id}}
    # Required: OAuth 2.0 Bearer token with tweet.write scope
    # ──────────────────────────────────────────────────────────────────────
    log.warning("x_engagement_stub_activated_but_not_implemented", org_id=str(org_id))
    return EngagementResult(
        success=False,
        error_category="PLATFORM_DISABLED",
        error_message="X engagement execution is not yet implemented.",
    )
