"""
LinkedIn engagement executor — comment and reply via Social Actions API.

API reference:
  POST https://api.linkedin.com/v2/socialActions/{parentUrn}/comments

Supports:
  comment — post a new comment on a LinkedIn post (share or ugcPost URN)
  reply   — reply to an existing comment (parent comment URN)

The distinction between comment and reply is determined by what is stored
in engagement_opportunities.post_platform_id:
  - For 'comment': post_platform_id = the LinkedIn share/ugcPost URN
  - For 'reply':   post_platform_id = the parent comment URN

Both actions use the same API endpoint structure — the parent entity type
determines whether it's a top-level comment or a reply.

Required OAuth scope: w_organization_social (org page) or w_member_social (person)
The scope must be granted at connect time; engagement will fail with AUTH_FAILED
if only the read scopes were granted.

Actor URN:
  Derived from social_accounts.platform_account_id.
  If already contains 'urn:li:', used as-is.
  Otherwise treated as person ID → urn:li:person:{id}.

Return type: EngagementResult (from executor module pattern)
  success, platform_action_id (LinkedIn comment URN), error_category, error_message
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Optional

import httpx

from app.logging_config import get_logger
from app.publishers.error_normalizer import normalize_error
from app.publishers.meta import resolve_account

log = get_logger(__name__)

_SOCIAL_ACTIONS_BASE = "https://api.linkedin.com/v2/socialActions"
_TIMEOUT = 20.0


@dataclass
class EngagementResult:
    success:            bool
    platform_action_id: Optional[str] = None
    error_category:     Optional[str] = None
    error_message:      Optional[str] = None
    http_status:        Optional[int] = None


async def execute_linkedin_engagement(
    pool,
    org_id: uuid.UUID,
    platform: str,           # always "linkedin" — passed for symmetry with meta
    post_platform_id: str,   # parent URN (post or comment URN)
    action_text: str,
    action_type: str,        # "comment" | "reply" — logged but API call is same
) -> EngagementResult:
    """
    Post a comment or reply on LinkedIn.

    post_platform_id for comment: share/ugcPost URN of the target post
    post_platform_id for reply:   parent comment URN

    Never raises. All errors are returned in EngagementResult.
    """
    from app.publishers.meta import resolve_account as _resolve
    from app.publishers.linkedin import _ensure_urn   # reuse URN normalizer

    # Resolve OAuth credentials
    account = await _resolve(pool, org_id, "linkedin")
    if not account:
        return EngagementResult(
            success=False,
            error_category="AUTH_FAILED",
            error_message="No connected LinkedIn account found for this org.",
        )

    actor_urn = _ensure_urn(account["platform_account_id"])
    access_token = account["access_token"]
    parent_urn = post_platform_id.strip()

    payload = {
        "actor": actor_urn,
        "message": {
            "text": action_text,
            "attributes": [],
        },
    }

    headers = {
        "Authorization":              f"Bearer {access_token}",
        "Content-Type":               "application/json",
        "X-Restli-Protocol-Version":  "2.0.0",
        "LinkedIn-Version":           "202304",
    }

    url = f"{_SOCIAL_ACTIONS_BASE}/{parent_urn}/comments"

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(url, json=payload, headers=headers)
    except Exception as exc:
        category = normalize_error("linkedin", None, None, exc)
        log.warning("linkedin_engagement_request_failed", error=str(exc))
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
        # LinkedIn returns the comment URN in x-restli-id header or response body
        comment_urn = resp.headers.get("x-restli-id") or _extract_li_id(body)
        log.info(
            "linkedin_engagement_success",
            org_id=str(org_id), action_type=action_type,
            parent_urn=parent_urn, comment_urn=comment_urn,
        )
        return EngagementResult(
            success=True,
            platform_action_id=comment_urn,
            http_status=http_status,
        )

    category = normalize_error("linkedin", http_status, body)
    error_msg = _extract_li_error(body)
    log.warning(
        "linkedin_engagement_failed",
        org_id=str(org_id), action_type=action_type,
        http_status=http_status, category=category, error=error_msg,
    )
    return EngagementResult(
        success=False,
        error_category=category,
        error_message=error_msg,
        http_status=http_status,
    )


def _extract_li_id(body: Optional[dict]) -> Optional[str]:
    """Extract URN/id from LinkedIn response body."""
    if not body:
        return None
    return body.get("id") or body.get("urn")


def _extract_li_error(body: Optional[dict]) -> str:
    if not body:
        return "Unknown LinkedIn error"
    return str(body.get("message", body.get("error", str(body)[:200])))
