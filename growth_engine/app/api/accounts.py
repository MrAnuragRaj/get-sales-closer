"""
Social account connection health.

Routes:
  GET /growth/accounts/status — per-platform connection status for the caller's org

Returns one entry per known platform (linkedin, facebook, instagram, x).
Each entry includes:
  - status: connected | disconnected | error | reauth_required | not_connected | feature_disabled
  - token_expired: whether token_expires_at is in the past
  - last_publish_success: most recent successful publish timestamp for this platform
  - last_publish_failure: most recent failed publish timestamp + error for this platform

Used by the dashboard Connection Health strip.
X is always returned as feature_disabled when PLATFORM_X_ENABLED=false.
"""

from __future__ import annotations

from datetime import datetime, timezone

import asyncpg
from fastapi import APIRouter, Depends

from app.auth_bridge import AuthContext, require_auth
from app.config import settings
from app.db import get_pool
from app.logging_config import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/accounts", tags=["accounts"])

# All platforms the Growth Engine knows about, in display order
_ALL_PLATFORMS = ("linkedin", "facebook", "instagram", "x")


@router.get("/status")
async def get_account_status(
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict:
    """
    Return connection health for all platforms for the caller's org.

    Each platform entry is always present — the 'not_connected' status
    is returned for platforms with no social_accounts row.
    X is returned as 'feature_disabled' when PLATFORM_X_ENABLED=false
    regardless of whether an account row exists.
    """
    enabled = set(settings.enabled_platforms())
    now = datetime.now(tz=timezone.utc)

    async with pool.acquire() as conn:
        account_rows = await conn.fetch(
            """
            SELECT platform, platform_account_id, display_name, status,
                   token_expires_at, last_sync_at, updated_at,
                   engage_capable, engage_status_reason,
                   publish_capable, publish_status_reason
            FROM growth.social_accounts
            WHERE org_id = $1
            """,
            auth.org_id,
        )

        # Latest successful publish per platform
        success_rows = await conn.fetch(
            """
            SELECT platform,
                   MAX(updated_at) AS last_success_at
            FROM growth.publish_queue
            WHERE org_id = $1
              AND status = 'published'
            GROUP BY platform
            """,
            auth.org_id,
        )

        # Latest failure per platform (any terminal-fail status)
        failure_rows = await conn.fetch(
            """
            SELECT DISTINCT ON (platform)
                   platform, status AS fail_status, last_error, updated_at AS last_failure_at
            FROM growth.publish_queue
            WHERE org_id = $1
              AND status IN ('failed', 'blocked_auth', 'blocked_quota')
            ORDER BY platform, updated_at DESC
            """,
            auth.org_id,
        )

    # Build lookup maps
    accounts_by_platform = {row["platform"]: dict(row) for row in account_rows}
    success_by_platform  = {row["platform"]: row["last_success_at"] for row in success_rows}
    failure_by_platform  = {row["platform"]: dict(row) for row in failure_rows}

    platforms_out = []
    for platform in _ALL_PLATFORMS:
        # Feature-disabled check first (X in v1)
        if platform not in enabled:
            platforms_out.append({
                "platform":             platform,
                "status":               "feature_disabled",
                "display_name":         None,
                "platform_account_id":  None,
                "token_expired":        False,
                "token_expires_at":     None,
                "last_sync_at":         None,
                "last_publish_success": None,
                "last_publish_failure": None,
                "last_failure_error":   None,
                "engage_capable":       False,
                "engage_status_reason": "feature_disabled",
                "reconnect_url":        None,
            })
            continue

        # Instagram engage is always platform_unsupported regardless of connection
        if platform == "instagram":
            _instagram_engage_capable = False
            _instagram_engage_reason  = "platform_unsupported"
        else:
            _instagram_engage_capable = None  # resolved per-account below
            _instagram_engage_reason  = None

        acct = accounts_by_platform.get(platform)
        if not acct:
            platforms_out.append({
                "platform":             platform,
                "status":               "not_connected",
                "display_name":         None,
                "platform_account_id":  None,
                "token_expired":        False,
                "token_expires_at":     None,
                "last_sync_at":         None,
                "last_publish_success": _fmt_dt(success_by_platform.get(platform)),
                "last_publish_failure": _fmt_dt(failure_by_platform.get(platform, {}).get("last_failure_at")),
                "last_failure_error":   failure_by_platform.get(platform, {}).get("last_error"),
                "engage_capable":       _instagram_engage_capable if platform == "instagram" else False,
                "engage_status_reason": _instagram_engage_reason  if platform == "instagram" else "no_account",
                "reconnect_url":        _reconnect_url(platform),
            })
            continue

        # Check token expiry
        token_expires_at = acct.get("token_expires_at")
        token_expired = bool(
            token_expires_at
            and token_expires_at.replace(tzinfo=timezone.utc) < now
        ) if token_expires_at else False

        # Effective status: if token is expired, override to reauth_required
        effective_status = acct["status"]
        if token_expired and effective_status == "connected":
            effective_status = "reauth_required"

        fail = failure_by_platform.get(platform, {})

        # Engagement capability: Instagram is always platform_unsupported;
        # others read from persisted capability (may be None if never evaluated — default False)
        if platform == "instagram":
            engage_capable       = False
            engage_status_reason = "platform_unsupported"
        else:
            engage_capable       = bool(acct.get("engage_capable"))
            engage_status_reason = acct.get("engage_status_reason") or ("ok" if engage_capable else "no_account")

        platforms_out.append({
            "platform":             platform,
            "status":               effective_status,
            "display_name":         acct.get("display_name"),
            "platform_account_id":  acct.get("platform_account_id"),
            "token_expired":        token_expired,
            "token_expires_at":     _fmt_dt(token_expires_at),
            "last_sync_at":         _fmt_dt(acct.get("last_sync_at")),
            "last_publish_success": _fmt_dt(success_by_platform.get(platform)),
            "last_publish_failure": _fmt_dt(fail.get("last_failure_at")),
            "last_failure_error":   fail.get("last_error"),
            "engage_capable":       engage_capable,
            "engage_status_reason": engage_status_reason,
            "reconnect_url":        _reconnect_url(platform) if effective_status != "connected" else None,
        })

    connected_count = sum(1 for p in platforms_out if p["status"] == "connected")
    needs_attention = [
        p["platform"] for p in platforms_out
        if p["status"] in ("reauth_required", "error", "not_connected")
    ]

    return {
        "org_id":           str(auth.org_id),
        "connected_count":  connected_count,
        "needs_attention":  needs_attention,
        "platforms":        platforms_out,
    }


def _fmt_dt(dt) -> str | None:
    if dt is None:
        return None
    if isinstance(dt, datetime):
        return dt.isoformat()
    return str(dt)


def _reconnect_url(platform: str) -> str | None:
    """
    Return the OAuth re-connect URL for each platform.

    LinkedIn and Meta (Facebook/Instagram) use Growth Engine OAuth flows.
    X is currently feature_disabled so no reconnect URL is provided.
    These paths must match the OAuth routes when they are built in Phase 8.
    """
    urls = {
        "linkedin":  "/growth/oauth/linkedin/connect",
        "facebook":  "/growth/oauth/meta/connect",
        "instagram": "/growth/oauth/meta/connect",   # same Meta OAuth flow
    }
    return urls.get(platform)
