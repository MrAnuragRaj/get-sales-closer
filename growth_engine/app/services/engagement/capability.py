"""
Engagement capability evaluation.

Determines, for each platform connection, whether the stored token/scopes
allow publishing and/or engagement (commenting/replying).

Capability states (canonical):
  ok                  — capable and ready
  no_account          — no social_accounts row for this org+platform
  token_expired       — token_expires_at is in the past
  missing_scope       — connected but OAuth scopes insufficient
  platform_unsupported — platform does not support this capability via official API
  feature_disabled    — disabled by server-side feature flag (e.g. X in v1)
  error               — unexpected evaluation failure

Publish capability:
  LinkedIn:  connected + not expired
  Facebook:  connected + not expired
  Instagram: connected + not expired
  X:         feature_disabled (PLATFORM_X_ENABLED=false in v1)

Engage capability:
  LinkedIn:  connected + not expired + w_organization_social or w_member_social in scopes
  Facebook:  connected + not expired + pages_manage_posts or pages_manage_engagement in scopes
  Instagram: ALWAYS platform_unsupported
             (instagram_manage_comments only manages own post comments;
              commenting on arbitrary third-party posts is not supported
              via the official Meta Graph API)
  X:         feature_disabled

Required scopes per platform:
  LinkedIn publish  : r_liteprofile or r_organization_social (read) + w_member_social or w_organization_social
  LinkedIn engage   : w_organization_social or w_member_social
  Facebook publish  : pages_manage_posts
  Facebook engage   : pages_manage_posts or pages_manage_engagement
  (scopes_json is populated at OAuth connect time; if empty, capability
   defaults to True for publish, False for engage — conservative on engage)

Results are persisted back to social_accounts (publish_capable, engage_capable,
*_status_reason, last_capability_check) so account/status reads are fast.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

import asyncpg

from app.config import settings
from app.logging_config import get_logger

log = get_logger(__name__)

# Required scopes for engagement capability per platform
_ENGAGE_SCOPES: dict[str, frozenset[str]] = {
    "linkedin":  frozenset({"w_organization_social", "w_member_social"}),
    "facebook":  frozenset({"pages_manage_posts", "pages_manage_engagement"}),
}

# Required scopes for publish capability per platform
_PUBLISH_SCOPES: dict[str, frozenset[str]] = {
    "linkedin": frozenset({"w_member_social", "w_organization_social"}),
    "facebook": frozenset({"pages_manage_posts"}),
}


@dataclass(frozen=True)
class CapabilityResult:
    """
    Resolved capability for one platform connection.
    Immutable — constructed once per evaluation, never mutated.
    """
    platform:              str
    can_publish:           bool
    can_engage:            bool
    publish_status_reason: str   # 'ok' or a failure reason string
    engage_status_reason:  str   # 'ok' or a failure reason string


async def evaluate_and_persist(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str,
) -> CapabilityResult:
    """
    Evaluate capability for one platform, persist result, return CapabilityResult.

    Reads social_accounts, checks token expiry and scopes, writes back the
    evaluated capability fields and last_capability_check timestamp.

    Safe to call repeatedly — all writes are upserts/updates on existing rows.
    """
    result = await _evaluate(pool, org_id, platform)
    await _persist(pool, org_id, platform, result)
    return result


async def evaluate_all(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
) -> dict[str, CapabilityResult]:
    """
    Evaluate and persist capability for all known platforms.
    Returns dict keyed by platform name.
    """
    results: dict[str, CapabilityResult] = {}
    for platform in ("linkedin", "facebook", "instagram", "x"):
        try:
            results[platform] = await evaluate_and_persist(pool, org_id, platform)
        except Exception as exc:
            log.error("capability_eval_error", platform=platform, error=str(exc))
            results[platform] = CapabilityResult(
                platform=platform,
                can_publish=False,
                can_engage=False,
                publish_status_reason="error",
                engage_status_reason="error",
            )
    return results


async def get_engage_capable(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str,
) -> tuple[bool, str]:
    """
    Fast path: read persisted engage_capable from social_accounts.
    Used by executor before dispatching — avoids full re-evaluation on every call.
    Returns (capable, reason).

    Falls back to live evaluation if no persisted value exists.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT engage_capable, engage_status_reason, last_capability_check
            FROM growth.social_accounts
            WHERE org_id = $1 AND platform = $2
            LIMIT 1
            """,
            org_id, platform,
        )

    if not row:
        return False, "no_account"

    # If never evaluated or evaluated > 1 hour ago, re-evaluate
    last_check = row["last_capability_check"]
    now = datetime.now(tz=timezone.utc)
    needs_refresh = (
        last_check is None or
        (now - last_check.replace(tzinfo=timezone.utc)).total_seconds() > 3600
    )

    if needs_refresh:
        result = await evaluate_and_persist(pool, org_id, platform)
        return result.can_engage, result.engage_status_reason

    return bool(row["engage_capable"]), (row["engage_status_reason"] or "no_account")


# ── Internal evaluation logic ─────────────────────────────────────────────────

async def _evaluate(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str,
) -> CapabilityResult:
    """
    Core evaluation logic. Does not write to DB — pure computation from DB reads.
    """
    # ── Feature-disabled overrides ────────────────────────────────────────────
    if platform == "x":
        if not settings.platform_x_enabled:
            return CapabilityResult(
                platform="x",
                can_publish=False, can_engage=False,
                publish_status_reason="feature_disabled",
                engage_status_reason="feature_disabled",
            )

    if platform == "instagram":
        # Instagram publish: supported via Meta OAuth
        # Instagram engage: platform_unsupported (no API for commenting on others' posts)
        publish_result = await _evaluate_publish(pool, org_id, "instagram")
        return CapabilityResult(
            platform="instagram",
            can_publish=publish_result[0],
            can_engage=False,
            publish_status_reason=publish_result[1],
            engage_status_reason="platform_unsupported",
        )

    if not settings.enabled_platforms().__contains__(platform):
        return CapabilityResult(
            platform=platform,
            can_publish=False, can_engage=False,
            publish_status_reason="feature_disabled",
            engage_status_reason="feature_disabled",
        )

    publish_ok, publish_reason = await _evaluate_publish(pool, org_id, platform)
    engage_ok,  engage_reason  = await _evaluate_engage(pool, org_id, platform)

    return CapabilityResult(
        platform=platform,
        can_publish=publish_ok,
        can_engage=engage_ok,
        publish_status_reason=publish_reason,
        engage_status_reason=engage_reason,
    )


async def _evaluate_publish(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str,
) -> tuple[bool, str]:
    """Evaluate publish capability for a platform. Returns (capable, reason)."""
    row = await _fetch_account(pool, org_id, platform)
    if not row:
        return False, "no_account"

    if row["status"] in ("disconnected", "revoked"):
        return False, "disconnected"

    if row["status"] == "reauth_required":
        return False, "reauth_required"

    if _is_token_expired(row):
        return False, "token_expired"

    # Check publish scopes if scopes_json is populated
    scopes = _extract_scopes(row)
    if scopes:
        required = _PUBLISH_SCOPES.get(platform, frozenset())
        if required and not scopes.intersection(required):
            return False, "missing_scope"

    return True, "ok"


async def _evaluate_engage(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str,
) -> tuple[bool, str]:
    """Evaluate engagement capability for a platform. Returns (capable, reason)."""
    row = await _fetch_account(pool, org_id, platform)
    if not row:
        return False, "no_account"

    if row["status"] in ("disconnected", "revoked"):
        return False, "disconnected"

    if row["status"] == "reauth_required":
        return False, "reauth_required"

    if _is_token_expired(row):
        return False, "token_expired"

    # Check engagement scopes if scopes_json is populated
    scopes = _extract_scopes(row)
    required = _ENGAGE_SCOPES.get(platform, frozenset())
    if scopes and required:
        if not scopes.intersection(required):
            return False, "missing_scope"
    elif not scopes and required:
        # No scope info stored — conservative: report missing_scope for engagement
        # (publish is more lenient since it was working before scope tracking was added)
        return False, "missing_scope"

    return True, "ok"


async def _fetch_account(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str,
) -> Optional[dict]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, status, token_expires_at, scopes_json
            FROM growth.social_accounts
            WHERE org_id = $1 AND platform = $2
              AND status != 'disconnected'
            LIMIT 1
            """,
            org_id, platform,
        )
    return dict(row) if row else None


def _is_token_expired(row: dict) -> bool:
    """Return True if token_expires_at is set and is in the past."""
    exp = row.get("token_expires_at")
    if not exp:
        return False
    now = datetime.now(tz=timezone.utc)
    try:
        exp_tz = exp.replace(tzinfo=timezone.utc) if exp.tzinfo is None else exp
        return exp_tz < now
    except Exception:
        return False


def _extract_scopes(row: dict) -> Optional[frozenset[str]]:
    """Extract scopes_json as a frozenset of lowercase scope strings, or None."""
    raw = row.get("scopes_json")
    if not raw:
        return None
    if isinstance(raw, list):
        return frozenset(str(s).lower() for s in raw)
    if isinstance(raw, dict):
        # Some platforms return {"scope": "read,write"} or {"scopes": [...]}
        scopes_val = raw.get("scope") or raw.get("scopes", "")
        if isinstance(scopes_val, str):
            return frozenset(s.strip().lower() for s in scopes_val.split(",") if s.strip())
        if isinstance(scopes_val, list):
            return frozenset(str(s).lower() for s in scopes_val)
    return None


async def _persist(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str,
    result: CapabilityResult,
) -> None:
    """Write evaluated capability back to social_accounts."""
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE growth.social_accounts
            SET publish_capable        = $1,
                engage_capable         = $2,
                publish_status_reason  = $3,
                engage_status_reason   = $4,
                last_capability_check  = NOW(),
                updated_at             = NOW()
            WHERE org_id = $5 AND platform = $6
            """,
            result.can_publish,
            result.can_engage,
            result.publish_status_reason,
            result.engage_status_reason,
            org_id,
            platform,
        )
    log.debug(
        "capability_persisted",
        org_id=str(org_id), platform=platform,
        can_publish=result.can_publish, can_engage=result.can_engage,
        publish_reason=result.publish_status_reason,
        engage_reason=result.engage_status_reason,
    )
