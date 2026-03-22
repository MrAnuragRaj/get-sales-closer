"""
Meta engagement executor — Facebook comment/reply via Graph API.

Facebook:
  POST https://graph.facebook.com/v21.0/{object_id}/comments
  {message: "text", access_token: "page_token"}

  For 'comment':  object_id = Facebook post ID (e.g. "123456789_987654321")
  For 'reply':    object_id = parent comment ID

  Requires page access token with pages_manage_posts or pages_manage_engagement scope.
  Returns {"id": "comment_id"} on success.

Instagram:
  Outbound commenting on other users' posts is NOT supported via the official
  instagram_manage_comments API permission. That permission only manages comments
  on the org's OWN posts.

  This adapter always returns PLATFORM_DISABLED for Instagram engagement.
  The UI shows: "Instagram engagement is not supported by the official API
  for commenting on other users' posts."

  This is a platform-level restriction, not a missing implementation.

Return type: EngagementResult (same dataclass as linkedin_executor)
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Optional

import httpx

from app.logging_config import get_logger
from app.publishers.error_normalizer import normalize_error

log = get_logger(__name__)

_GRAPH_BASE = "https://graph.facebook.com/v21.0"
_TIMEOUT = 20.0

_INSTAGRAM_UNSUPPORTED_MESSAGE = (
    "Instagram engagement is not supported by the official API "
    "for commenting on other users' posts. "
    "The instagram_manage_comments permission only manages comments on your own media."
)


@dataclass
class EngagementResult:
    success:            bool
    platform_action_id: Optional[str] = None
    error_category:     Optional[str] = None
    error_message:      Optional[str] = None
    http_status:        Optional[int] = None


async def execute_meta_engagement(
    pool,
    org_id: uuid.UUID,
    platform: str,           # "facebook" | "instagram"
    post_platform_id: str,   # Facebook post ID or comment ID
    action_text: str,
    action_type: str,        # "comment" | "reply"
) -> EngagementResult:
    """
    Post a comment or reply via Meta Graph API.

    Instagram always returns PLATFORM_DISABLED.
    Facebook executes the comment and returns the comment ID.

    Never raises. All errors are returned in EngagementResult.
    """
    if platform == "instagram":
        log.info(
            "meta_engagement_instagram_unsupported",
            org_id=str(org_id), action_type=action_type,
        )
        return EngagementResult(
            success=False,
            error_category="PLATFORM_DISABLED",
            error_message=_INSTAGRAM_UNSUPPORTED_MESSAGE,
        )

    return await _execute_facebook(pool, org_id, post_platform_id, action_text, action_type)


async def _execute_facebook(
    pool,
    org_id: uuid.UUID,
    post_platform_id: str,
    action_text: str,
    action_type: str,
) -> EngagementResult:
    """Post a comment or reply on a Facebook page post/comment."""
    from app.publishers.meta import resolve_meta_account

    account = await resolve_meta_account(pool, org_id, "facebook")
    if not account:
        return EngagementResult(
            success=False,
            error_category="AUTH_FAILED",
            error_message="No connected Facebook account found for this org.",
        )

    access_token = account["access_token"]
    object_id = post_platform_id.strip()
    url = f"{_GRAPH_BASE}/{object_id}/comments"

    # Graph API accepts form-encoded or JSON; use params to keep token out of body logs
    params = {"access_token": access_token}
    payload = {"message": action_text}

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(url, params=params, json=payload)
    except Exception as exc:
        category = normalize_error("facebook", None, None, exc)
        log.warning("facebook_engagement_request_failed", error=str(exc))
        return EngagementResult(
            success=False,
            error_category=category,
            error_message=str(exc),
        )

    http_status = resp.status_code
    try:
        body = resp.json()
    except Exception:
        body = {"raw": resp.text[:300]}

    if http_status in (200, 201):
        comment_id = body.get("id")
        log.info(
            "facebook_engagement_success",
            org_id=str(org_id), action_type=action_type,
            object_id=object_id, comment_id=comment_id,
        )
        return EngagementResult(
            success=True,
            platform_action_id=comment_id,
            http_status=http_status,
        )

    category = normalize_error("facebook", http_status, body)
    error_msg = _extract_meta_error(body)
    log.warning(
        "facebook_engagement_failed",
        org_id=str(org_id), action_type=action_type,
        http_status=http_status, category=category, error=error_msg,
    )
    return EngagementResult(
        success=False,
        error_category=category,
        error_message=error_msg,
        http_status=http_status,
    )


def _extract_meta_error(body: Optional[dict]) -> str:
    if not body:
        return "Unknown Meta error"
    error = body.get("error", {})
    if isinstance(error, dict):
        return str(error.get("message", str(body)[:200]))
    return str(body)[:200]
