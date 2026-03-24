"""
Meta (Facebook + Instagram) OAuth 2.0 flow.

──────────────────────────────────────────────────────────────────────────────
ROUTES (no JWT auth middleware — browser redirect flow)
──────────────────────────────────────────────────────────────────────────────

  GET  /oauth/meta/connect    — Starts OAuth; browser is redirected to Facebook.
                                Accepts ?token=<supabase_jwt> to identify the org.
                                Connects BOTH Facebook Pages AND linked Instagram
                                Business accounts in a single flow.
                                Returns 302 → Facebook authorization URL.

  GET  /oauth/meta/callback   — Facebook redirects here after user grants access.
                                Exchanges code → long-lived user token → pages list
                                → upserts growth.social_accounts for each page
                                (facebook) and each linked Instagram Business account,
                                then redirects back to the Growth Dashboard.

  DELETE /oauth/meta/{platform} — Disconnects a platform (marks row 'disconnected').
                                  Requires standard Bearer JWT (header).
                                  platform = 'facebook' | 'instagram'

──────────────────────────────────────────────────────────────────────────────
META APP REQUIREMENTS
──────────────────────────────────────────────────────────────────────────────

Products to add on the Meta Developer App:
  1. "Facebook Login" — enables pages_show_list, pages_manage_posts
  2. "Instagram Graph API" — enables instagram_basic, instagram_content_publish

OAuth redirect URL to register in app settings → Facebook Login → Valid OAuth
redirect URIs:
    https://<your-railway-domain>/growth/oauth/meta/callback

Env vars required in Railway:
    META_APP_ID      — from app Dashboard → App ID
    META_APP_SECRET  — from app Dashboard → App Secret

──────────────────────────────────────────────────────────────────────────────
SCOPES
──────────────────────────────────────────────────────────────────────────────

    pages_show_list,pages_manage_posts,pages_read_engagement,
    instagram_basic,instagram_content_publish

  - pages_show_list          → list pages the user manages + page access tokens
  - pages_manage_posts       → create/delete posts on pages
  - pages_read_engagement    → read page metrics
  - instagram_basic          → basic Instagram Business account access
  - instagram_content_publish → publish media to Instagram Business accounts

──────────────────────────────────────────────────────────────────────────────
ACCOUNT STORAGE
──────────────────────────────────────────────────────────────────────────────

Facebook Pages:
    platform              = 'facebook'
    platform_account_id   = page_id
    access_token_enc      = encrypted page access token (long-lived, no expiry)
    engage_capable        = true  (Facebook commenting via Graph API is supported)

Instagram Business:
    platform              = 'instagram'
    platform_account_id   = instagram_business_account_id
    access_token_enc      = encrypted page access token of the linked Facebook page
    engage_capable        = false  (Instagram commenting on others' posts not supported by API)
    engage_status_reason  = 'platform_unsupported'

Page access tokens don't expire as long as the user hasn't revoked the app.
No user access token is stored — only page-level tokens.
"""

from __future__ import annotations

import json
import secrets
import uuid
from urllib.parse import urlencode

import asyncpg
import jwt as pyjwt
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, Path, Query
from fastapi.responses import RedirectResponse
from httpx import AsyncClient

from app.auth_bridge import AuthContext, _decode_jwt, require_auth
from app.config import settings
from app.crypto import encrypt_token
from app.db import get_pool
from app.logging_config import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/oauth/meta", tags=["oauth"])

# ── Meta Graph API endpoints ──────────────────────────────────────────────────
_GRAPH_API    = "https://graph.facebook.com/v21.0"
_AUTHORIZE_URL = "https://www.facebook.com/v21.0/dialog/oauth"
_TOKEN_URL    = f"{_GRAPH_API}/oauth/access_token"

# Scopes for Facebook Pages posting + Instagram Business posting
_SCOPES = "pages_show_list,pages_manage_posts,pages_read_engagement,instagram_business_basic,instagram_business_content_publish"


# ── State helpers (same Fernet pattern as oauth_linkedin.py) ──────────────────

def _make_state(org_id: uuid.UUID) -> str:
    fernet = Fernet(settings.growth_encryption_key.encode())
    nonce = secrets.token_hex(16)
    return fernet.encrypt(f"{org_id}:{nonce}".encode()).decode()


def _decode_state(state: str) -> uuid.UUID:
    fernet = Fernet(settings.growth_encryption_key.encode())
    try:
        payload = fernet.decrypt(state.encode(), ttl=900).decode()
    except InvalidToken:
        raise ValueError("Invalid or expired OAuth state token (possible CSRF or replay).")
    parts = payload.split(":", 1)
    if len(parts) != 2:
        raise ValueError("Malformed OAuth state payload.")
    try:
        return uuid.UUID(parts[0])
    except ValueError:
        raise ValueError("OAuth state contains invalid org_id.")


# ── URL helpers ───────────────────────────────────────────────────────────────

def _callback_url() -> str:
    import os
    domain = os.environ.get("RAILWAY_STATIC_URL") or os.environ.get("SERVICE_DOMAIN", "")
    if domain and not domain.startswith("http"):
        domain = f"https://{domain}"
    return f"{domain.rstrip('/')}/growth/oauth/meta/callback"


def _dashboard_url(success: bool, error: str = "") -> str:
    gsc_domain = settings.gsc_dashboard_url.rstrip("/")
    if success:
        return f"{gsc_domain}/growth_dashboard.html?meta_connected=1"
    return f"{gsc_domain}/growth_dashboard.html?meta_error={error}"


# ── Route 1: GET /growth/oauth/meta/connect ───────────────────────────────────

@router.get("/connect")
async def meta_connect(
    token: str = Query(..., description="Supabase JWT — identifies the org"),
    pool: asyncpg.Pool = Depends(get_pool),
) -> RedirectResponse:
    """
    Start the Meta OAuth flow.

    Dashboard JS calls this as a browser redirect for both Facebook and Instagram:
        window.location.href = `${GROWTH_ENGINE_URL}/growth/oauth/meta/connect?token=${jwt}`;

    1. Validate Supabase JWT → user_id.
    2. Resolve org from org_members.
    3. Verify Growth Engine entitlement.
    4. Generate encrypted state (CSRF protection + org binding).
    5. Redirect browser to Facebook authorization URL.
    """
    # ── 1. Validate JWT ───────────────────────────────────────────────────────
    try:
        payload = _decode_jwt(token)
    except pyjwt.ExpiredSignatureError:
        return RedirectResponse(_dashboard_url(False, "token_expired"))
    except pyjwt.InvalidTokenError:
        return RedirectResponse(_dashboard_url(False, "invalid_token"))

    user_id_str = payload.get("sub", "")
    if not user_id_str:
        return RedirectResponse(_dashboard_url(False, "invalid_token"))
    try:
        user_id = uuid.UUID(user_id_str)
    except ValueError:
        return RedirectResponse(_dashboard_url(False, "invalid_token"))

    # ── 2 & 3. Resolve org + check entitlement ────────────────────────────────
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT om.org_id FROM public.org_members om
                WHERE om.user_id = $1
                ORDER BY CASE om.role
                    WHEN 'agency_admin'     THEN 1
                    WHEN 'enterprise_admin' THEN 2
                    WHEN 'enterprise_agent' THEN 3
                    ELSE 4
                END ASC LIMIT 1
                """,
                user_id,
            )
            if not row:
                return RedirectResponse(_dashboard_url(False, "no_membership"))

            org_id: uuid.UUID = row["org_id"]

            svc = await conn.fetchrow(
                "SELECT status FROM public.org_services WHERE org_id = $1 AND service_key = 'growth_engine'",
                org_id,
            )
            if not svc or svc["status"] != "active":
                return RedirectResponse(_dashboard_url(False, "not_entitled"))
    except Exception as exc:
        log.error("meta_connect_db_error", error=str(exc))
        return RedirectResponse(_dashboard_url(False, "server_error"))

    # ── 4. Build Facebook authorization URL ───────────────────────────────────
    if not settings.meta_app_id:
        log.error("meta_connect_missing_app_id")
        return RedirectResponse(_dashboard_url(False, "not_configured"))

    if not settings.growth_encryption_key:
        log.error("meta_connect_missing_encryption_key")
        return RedirectResponse(_dashboard_url(False, "not_configured"))

    try:
        state = _make_state(org_id)
    except Exception as exc:
        log.error("meta_connect_state_failed", error=str(exc))
        return RedirectResponse(_dashboard_url(False, "not_configured"))

    params = urlencode({
        "client_id":     settings.meta_app_id,
        "redirect_uri":  _callback_url(),
        "state":         state,
        "scope":         _SCOPES,
        "response_type": "code",
    })

    log.info("meta_oauth_initiated", org_id=str(org_id))
    return RedirectResponse(f"{_AUTHORIZE_URL}?{params}", status_code=302)


# ── Route 2: GET /growth/oauth/meta/callback ──────────────────────────────────

@router.get("/callback")
async def meta_callback(
    code: str | None       = Query(None),
    state: str | None      = Query(None),
    error: str | None      = Query(None),
    error_description: str | None = Query(None),
    pool: asyncpg.Pool     = Depends(get_pool),
) -> RedirectResponse:
    """
    Facebook redirects here after user grants (or denies) access.

    1. Handle user-denied or error case.
    2. Decrypt state → org_id (CSRF protection).
    3. Exchange authorization code for short-lived user access token.
    4. Exchange for long-lived user access token (60-day TTL).
    5. Fetch /me/accounts (pages the user manages + page access tokens +
       linked Instagram Business accounts in a single request).
    6. Upsert growth.social_accounts for each Facebook page.
    7. Upsert growth.social_accounts for each linked Instagram Business account.
    8. Redirect back to the Growth Dashboard.
    """
    # ── 1. User denied / Facebook error ──────────────────────────────────────
    if error:
        log.warning("meta_oauth_denied", error=error, description=error_description)
        return RedirectResponse(_dashboard_url(False, "access_denied"))

    if not code or not state:
        return RedirectResponse(_dashboard_url(False, "missing_params"))

    # ── 2. Decode state → org_id ──────────────────────────────────────────────
    try:
        org_id = _decode_state(state)
    except ValueError as exc:
        log.warning("meta_oauth_bad_state", detail=str(exc))
        return RedirectResponse(_dashboard_url(False, "invalid_state"))

    # ── 3. Exchange code for short-lived user access token ────────────────────
    async with AsyncClient(timeout=20.0) as http:
        token_res = await http.get(
            _TOKEN_URL,
            params={
                "client_id":     settings.meta_app_id,
                "client_secret": settings.meta_app_secret,
                "redirect_uri":  _callback_url(),
                "code":          code,
            },
        )

    if token_res.status_code != 200:
        log.error("meta_token_exchange_failed", status=token_res.status_code, body=token_res.text[:200], org_id=str(org_id))
        return RedirectResponse(_dashboard_url(False, "token_exchange_failed"))

    short_user_token = token_res.json().get("access_token", "")
    if not short_user_token:
        log.error("meta_token_exchange_empty", org_id=str(org_id))
        return RedirectResponse(_dashboard_url(False, "token_exchange_failed"))

    # ── 4. Exchange for long-lived user token (60 days) ───────────────────────
    async with AsyncClient(timeout=20.0) as http:
        ll_res = await http.get(
            _TOKEN_URL,
            params={
                "grant_type":        "fb_exchange_token",
                "client_id":         settings.meta_app_id,
                "client_secret":     settings.meta_app_secret,
                "fb_exchange_token": short_user_token,
            },
        )

    if ll_res.status_code == 200:
        long_user_token = ll_res.json().get("access_token", short_user_token)
    else:
        log.warning("meta_ll_exchange_failed", status=ll_res.status_code, org_id=str(org_id))
        long_user_token = short_user_token  # fall back to short-lived

    # ── 5. Get pages + linked Instagram Business accounts ────────────────────
    # The 'instagram_business_account' nested field comes from the
    # Instagram Graph API. It returns {id, username} for each linked IBA.
    async with AsyncClient(timeout=20.0) as http:
        pages_res = await http.get(
            f"{_GRAPH_API}/me/accounts",
            params={
                "access_token": long_user_token,
                "fields": "id,name,access_token,instagram_business_account{id,username}",
            },
        )

    if pages_res.status_code != 200:
        log.error("meta_pages_fetch_failed", status=pages_res.status_code, body=pages_res.text[:200], org_id=str(org_id))
        return RedirectResponse(_dashboard_url(False, "pages_fetch_failed"))

    pages = pages_res.json().get("data", [])
    if not pages:
        log.warning("meta_no_pages", org_id=str(org_id))
        return RedirectResponse(_dashboard_url(False, "no_pages"))

    # ── 6 & 7. Upsert Facebook pages + Instagram accounts ────────────────────
    accounts_saved = 0

    async with pool.acquire() as conn:
        for page in pages:
            page_id    = page.get("id", "")
            page_name  = page.get("name", "Facebook Page")
            page_token = page.get("access_token", "")

            if not page_id or not page_token:
                continue

            try:
                page_token_enc = encrypt_token(page_token)
            except Exception as exc:
                log.error("meta_page_token_encrypt_failed", page_id=page_id, error=str(exc))
                continue

            # ── Facebook page ─────────────────────────────────────────────────
            try:
                await conn.execute(
                    """
                    INSERT INTO growth.social_accounts (
                        org_id, platform, platform_account_id, display_name,
                        access_token_enc, token_expires_at,
                        status, publish_capable, engage_capable,
                        publish_status_reason, engage_status_reason,
                        scopes_json, meta_json, updated_at
                    ) VALUES (
                        $1, 'facebook', $2, $3,
                        $4, NULL,
                        'connected', true, true,
                        'ok', 'ok',
                        $5, $6, now()
                    )
                    ON CONFLICT (org_id, platform, platform_account_id)
                    DO UPDATE SET
                        display_name          = EXCLUDED.display_name,
                        access_token_enc      = EXCLUDED.access_token_enc,
                        status                = 'connected',
                        publish_capable       = true,
                        engage_capable        = true,
                        publish_status_reason = 'ok',
                        engage_status_reason  = 'ok',
                        scopes_json           = EXCLUDED.scopes_json,
                        meta_json             = EXCLUDED.meta_json,
                        updated_at            = now()
                    """,
                    org_id, page_id, page_name, page_token_enc,
                    json.dumps({"scopes": _SCOPES.split(",")}),
                    json.dumps({"page_id": page_id}),
                )
                accounts_saved += 1
                log.info("meta_facebook_page_saved", org_id=str(org_id), page_id=page_id, name=page_name)
            except Exception as exc:
                log.error("meta_fb_upsert_failed", org_id=str(org_id), page_id=page_id, error=str(exc))

            # ── Instagram Business account linked to this page ────────────────
            ig = page.get("instagram_business_account")
            if ig:
                ig_id       = ig.get("id", "")
                ig_username = ig.get("username") or "Instagram Account"
                if ig_id:
                    try:
                        await conn.execute(
                            """
                            INSERT INTO growth.social_accounts (
                                org_id, platform, platform_account_id, display_name,
                                access_token_enc, token_expires_at,
                                status, publish_capable, engage_capable,
                                publish_status_reason, engage_status_reason,
                                scopes_json, meta_json, updated_at
                            ) VALUES (
                                $1, 'instagram', $2, $3,
                                $4, NULL,
                                'connected', true, false,
                                'ok', 'platform_unsupported',
                                $5, $6, now()
                            )
                            ON CONFLICT (org_id, platform, platform_account_id)
                            DO UPDATE SET
                                display_name          = EXCLUDED.display_name,
                                access_token_enc      = EXCLUDED.access_token_enc,
                                status                = 'connected',
                                publish_capable       = true,
                                engage_capable        = false,
                                publish_status_reason = 'ok',
                                engage_status_reason  = 'platform_unsupported',
                                scopes_json           = EXCLUDED.scopes_json,
                                meta_json             = EXCLUDED.meta_json,
                                updated_at            = now()
                            """,
                            org_id, ig_id, ig_username, page_token_enc,
                            json.dumps({"scopes": _SCOPES.split(",")}),
                            json.dumps({"linked_page_id": page_id, "ig_username": ig_username}),
                        )
                        accounts_saved += 1
                        log.info("meta_instagram_account_saved", org_id=str(org_id), ig_id=ig_id, username=ig_username)
                    except Exception as exc:
                        log.error("meta_ig_upsert_failed", org_id=str(org_id), ig_id=ig_id, error=str(exc))

    log.info("meta_oauth_complete", org_id=str(org_id), accounts_saved=accounts_saved)
    return RedirectResponse(_dashboard_url(True))


# ── Route 3: DELETE /growth/oauth/meta/{platform} — disconnect ───────────────

@router.delete("/{platform}")
async def meta_disconnect(
    platform: str = Path(..., pattern="^(facebook|instagram)$"),
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict:
    """
    Disconnect Facebook or Instagram — sets status to 'disconnected', clears
    capability flags. Does NOT delete the row (preserves publish history).
    JWT required in Authorization header.
    """
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE growth.social_accounts
            SET status                = 'disconnected',
                publish_capable       = false,
                engage_capable        = false,
                publish_status_reason = 'disconnected',
                engage_status_reason  = 'disconnected',
                updated_at            = now()
            WHERE org_id  = $1
              AND platform = $2
              AND status  != 'disconnected'
            """,
            auth.org_id, platform,
        )

    affected = int(result.split()[-1]) if result else 0
    log.info("meta_disconnected", platform=platform, org_id=str(auth.org_id), rows_updated=affected)

    return {
        "disconnected": affected > 0,
        "message": (
            f"{platform.title()} disconnected."
            if affected > 0
            else f"No active {platform.title()} account found."
        ),
    }
