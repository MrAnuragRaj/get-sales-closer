"""
Meta bundled backend — shared token resolution for Facebook + Instagram.

Architecture (locked):
  Facebook and Instagram share ONE Meta OAuth session per org.
  In social_accounts:
    - The Facebook row stores the Page access token in access_token_enc
    - The Instagram row has meta_connection_id = UUID of the Facebook row
    - Both rows share the same encrypted token — the Instagram row's
      access_token_enc may also hold the same token for convenience

  Token resolution:
    1. Find the account row for the target platform
    2. If platform='instagram' AND meta_connection_id is set:
       fetch the referenced Facebook row to get the token
    3. Decrypt via crypto.decrypt_token()

  This means:
    - Revoking the Facebook token instantly breaks both FB + IG publishing
    - OAuth refresh must update BOTH rows (handled by connect-facebook-page
      edge function in the main GetSalesCloser codebase)

  platform_account_id for each platform:
    facebook:  the Facebook Page ID (used as /{page_id}/feed)
    instagram: the Instagram Business Account ID (used as /{ig_id}/media)

  Neither ID is a secret — they are platform-public identifiers.
"""

from __future__ import annotations

import uuid
from typing import Optional

import asyncpg

from app.crypto import decrypt_token
from app.logging_config import get_logger

log = get_logger(__name__)


async def resolve_meta_account(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str,
) -> Optional[dict]:
    """
    Return a resolved account dict for Facebook or Instagram.

    Returns:
        {
          "platform_account_id": str,   — page_id or ig_user_id
          "access_token": str,          — plaintext (decrypted from Fernet)
        }
        None if no connected account found.
    """
    if platform not in ("facebook", "instagram"):
        raise ValueError(f"meta.resolve_meta_account called for non-Meta platform: {platform}")

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, platform_account_id, access_token_enc, meta_connection_id
            FROM growth.social_accounts
            WHERE org_id = $1
              AND platform = $2
              AND status = 'connected'
            LIMIT 1
            """,
            org_id,
            platform,
        )

    if not row:
        log.warning("meta_account_not_found", org_id=str(org_id), platform=platform)
        return None

    token_enc = row["access_token_enc"]

    # For Instagram: if meta_connection_id is set, the token lives on the FB row
    if platform == "instagram" and row["meta_connection_id"]:
        fb_token_enc = await _fetch_meta_parent_token(pool, row["meta_connection_id"])
        if fb_token_enc:
            token_enc = fb_token_enc

    try:
        access_token = decrypt_token(token_enc)
    except Exception as exc:
        log.error("meta_token_decrypt_failed", platform=platform, error=str(exc))
        return None

    return {
        "platform_account_id": row["platform_account_id"],
        "access_token": access_token,
    }


async def _fetch_meta_parent_token(
    pool: asyncpg.Pool,
    connection_id: uuid.UUID,
) -> Optional[str]:
    """Fetch the access_token_enc from the parent Facebook social_account row."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT access_token_enc FROM growth.social_accounts WHERE id = $1",
            connection_id,
        )
    return row["access_token_enc"] if row else None


async def resolve_linkedin_account(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
) -> Optional[dict]:
    """Resolve a connected LinkedIn account for publishing."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT platform_account_id, access_token_enc
            FROM growth.social_accounts
            WHERE org_id  = $1
              AND platform = 'linkedin'
              AND status   = 'connected'
            LIMIT 1
            """,
            org_id,
        )

    if not row:
        log.warning("linkedin_account_not_found", org_id=str(org_id))
        return None

    try:
        access_token = decrypt_token(row["access_token_enc"])
    except Exception as exc:
        log.error("linkedin_token_decrypt_failed", error=str(exc))
        return None

    return {
        "platform_account_id": row["platform_account_id"],
        "access_token": access_token,
    }


async def resolve_account(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str,
) -> Optional[dict]:
    """
    Unified account resolver — routes to the correct backend.
    Returns {"platform_account_id": str, "access_token": str} or None.
    """
    if platform == "linkedin":
        return await resolve_linkedin_account(pool, org_id)
    if platform in ("facebook", "instagram"):
        return await resolve_meta_account(pool, org_id, platform)
    if platform == "x":
        return await _resolve_x_account(pool, org_id)
    return None


async def _resolve_x_account(pool: asyncpg.Pool, org_id: uuid.UUID) -> Optional[dict]:
    """X account resolution — returns None when X is disabled (v1)."""
    from app.config import settings
    if not settings.platform_x_enabled:
        return None
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT platform_account_id, access_token_enc
            FROM growth.social_accounts
            WHERE org_id = $1 AND platform = 'x' AND status = 'connected'
            LIMIT 1
            """,
            org_id,
        )
    if not row:
        return None
    try:
        return {
            "platform_account_id": row["platform_account_id"],
            "access_token": decrypt_token(row["access_token_enc"]),
        }
    except Exception:
        return None
