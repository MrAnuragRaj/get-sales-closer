"""
LinkedIn OAuth 2.0 flow (OpenID Connect + w_member_social).

──────────────────────────────────────────────────────────────────────────────
ROUTES (no JWT auth middleware — browser redirect flow)
──────────────────────────────────────────────────────────────────────────────

  GET  /oauth/linkedin/connect    — Starts OAuth; browser is redirected to LinkedIn.
                                    Accepts ?token=<supabase_jwt> to identify the org.
                                    Returns 302 → LinkedIn authorization URL.

  GET  /oauth/linkedin/callback   — LinkedIn redirects here after user grants access.
                                    Exchanges code for tokens, fetches /v2/userinfo,
                                    upserts growth.social_accounts, then redirects
                                    back to the Growth Dashboard.

  DELETE /oauth/linkedin          — Disconnects LinkedIn (marks row 'disconnected').
                                    Requires standard Bearer JWT (header).

──────────────────────────────────────────────────────────────────────────────
STATE / CSRF PROTECTION
──────────────────────────────────────────────────────────────────────────────

The OAuth `state` parameter contains a Fernet-encrypted payload:
    "<org_id>:<random_nonce>"

Fernet provides authenticated encryption — any tampering raises InvalidToken.
The callback verifies the state comes from us (CSRF protection) and recovers
the org_id without needing a server-side session store.

──────────────────────────────────────────────────────────────────────────────
LINKEDIN DEVELOPER APP REQUIREMENTS
──────────────────────────────────────────────────────────────────────────────

Products to request on the LinkedIn Developer App:
  1. "Sign In with LinkedIn using OpenID Connect" — enables openid, profile, email
  2. "Share on LinkedIn"                          — enables w_member_social

OAuth 2.0 redirect URL to add in the app settings:
    https://<your-railway-domain>/growth/oauth/linkedin/callback

Env vars required:
    LINKEDIN_CLIENT_ID      — from app Credentials tab
    LINKEDIN_CLIENT_SECRET  — from app Credentials tab

──────────────────────────────────────────────────────────────────────────────
SCOPES
──────────────────────────────────────────────────────────────────────────────

    openid profile email w_member_social

  - openid + profile + email → /v2/userinfo (person URN, name, email, picture)
  - w_member_social           → create UGC posts via /v2/ugcPosts

──────────────────────────────────────────────────────────────────────────────
TOKEN STORAGE
──────────────────────────────────────────────────────────────────────────────

Tokens are Fernet-encrypted using GROWTH_ENCRYPTION_KEY before being written
to growth.social_accounts.access_token_enc / refresh_token_enc.
Plaintext tokens are never logged and never returned to API callers.

platform_account_id = LinkedIn person URN  (e.g. "urn:li:person:AbC123Xyz")
This URN is required by the LinkedIn UGC Posts v2 API (publishers/linkedin.py).
"""

from __future__ import annotations

import secrets
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import asyncpg
import jwt as pyjwt
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, Query
from fastapi.responses import RedirectResponse
from httpx import AsyncClient

from app.auth_bridge import AuthContext, _decode_jwt, require_auth
from app.config import settings
from app.crypto import decrypt_token, encrypt_token
from app.db import get_pool
from app.logging_config import get_logger

log = get_logger(__name__)

router = APIRouter(prefix="/oauth/linkedin", tags=["oauth"])

# ── LinkedIn OAuth 2.0 endpoints ─────────────────────────────────────────────
_AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization"
_TOKEN_URL     = "https://www.linkedin.com/oauth/v2/accessToken"
_USERINFO_URL  = "https://api.linkedin.com/v2/userinfo"

# Scopes we request — must match the products approved on the LinkedIn app
_SCOPES = "openid profile email w_member_social"

# ── State encryption / decryption ─────────────────────────────────────────────
# We use the primary Fernet key (not MultiFernet) for state — state is short-lived
# (15 min) so key rotation fallback is not needed here.


def _make_state(org_id: uuid.UUID) -> str:
    """Encrypt org_id + random nonce into an opaque state string."""
    key_raw = settings.growth_encryption_key
    fernet = Fernet(key_raw.encode())
    nonce = secrets.token_hex(16)
    payload = f"{org_id}:{nonce}".encode()
    return fernet.encrypt(payload).decode()


def _decode_state(state: str) -> uuid.UUID:
    """Decrypt and return org_id from state. Raises ValueError on any failure."""
    key_raw = settings.growth_encryption_key
    fernet = Fernet(key_raw.encode())
    try:
        payload = fernet.decrypt(state.encode(), ttl=900).decode()  # 15-min TTL
    except InvalidToken:
        raise ValueError("Invalid or expired OAuth state token (possible CSRF or replay).")

    parts = payload.split(":", 1)
    if len(parts) != 2:
        raise ValueError("Malformed OAuth state payload.")

    try:
        return uuid.UUID(parts[0])
    except ValueError:
        raise ValueError("OAuth state contains invalid org_id.")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _callback_url() -> str:
    """
    Canonical redirect URI to register in your LinkedIn Developer App.
    Must match exactly what is configured there.
    Format: https://<railway-domain>/growth/oauth/linkedin/callback
    """
    # For local dev Railway sets RAILWAY_STATIC_URL; in prod use SERVICE_DOMAIN or equivalent.
    # This is constructed at runtime so deploying to a new domain auto-uses the right URL.
    import os
    domain = os.environ.get("RAILWAY_STATIC_URL") or os.environ.get("SERVICE_DOMAIN", "")
    if domain and not domain.startswith("http"):
        domain = f"https://{domain}"
    return f"{domain.rstrip('/')}/growth/oauth/linkedin/callback"


def _dashboard_url(success: bool, error: str = "") -> str:
    """Redirect target after OAuth completes — the Growth Dashboard."""
    gsc_domain = settings.gsc_dashboard_url.rstrip("/")
    if success:
        return f"{gsc_domain}/growth_dashboard.html?linkedin_connected=1"
    return f"{gsc_domain}/growth_dashboard.html?linkedin_error={error}"


# ── Route 1: /growth/oauth/linkedin/connect ──────────────────────────────────

@router.get("/connect")
async def linkedin_connect(
    token: str = Query(..., description="Supabase JWT — identifies the org"),
    pool: asyncpg.Pool = Depends(get_pool),
) -> RedirectResponse:
    """
    Start the LinkedIn OAuth flow.

    The dashboard JS calls this as a browser redirect:
        window.location.href = `${GROWTH_ENGINE_URL}/growth/oauth/linkedin/connect?token=${supabaseJwt}`;

    1. Validate the Supabase JWT to identify the user's org.
    2. Verify Growth Engine entitlement (org_services.status = 'active' for growth_engine).
    3. Generate an encrypted state token (CSRF protection + org binding).
    4. Redirect the browser to the LinkedIn authorization URL.
    """
    # ── 1. Validate Supabase JWT (ES256 via JWKS, fallback to HS256) ─────────
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

    # ── 2. Resolve org from org_members ──────────────────────────────────────
    try:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                SELECT om.org_id
                FROM public.org_members om
                WHERE om.user_id = $1
                ORDER BY
                    CASE om.role
                        WHEN 'agency_admin'     THEN 1
                        WHEN 'enterprise_admin' THEN 2
                        WHEN 'enterprise_agent' THEN 3
                        ELSE 4
                    END ASC,
                    om.created_at ASC
                LIMIT 1
                """,
                user_id,
            )
            if not row:
                return RedirectResponse(_dashboard_url(False, "no_membership"))

            org_id: uuid.UUID = row["org_id"]

            # ── 3. Verify Growth Engine entitlement ───────────────────────────
            svc_row = await conn.fetchrow(
                """
                SELECT status FROM public.org_services
                WHERE org_id = $1 AND service_key = 'growth_engine'
                """,
                org_id,
            )
            if not svc_row or svc_row["status"] != "active":
                return RedirectResponse(_dashboard_url(False, "not_entitled"))
    except Exception as exc:
        log.error("linkedin_connect_db_error", error=str(exc), user_id=str(user_id))
        return RedirectResponse(_dashboard_url(False, "server_error"))

    # ── 4. Build LinkedIn authorization URL ───────────────────────────────────
    if not settings.linkedin_client_id:
        log.error("linkedin_connect_missing_client_id")
        return RedirectResponse(_dashboard_url(False, "not_configured"))

    if not settings.growth_encryption_key:
        log.error("linkedin_connect_missing_encryption_key")
        return RedirectResponse(_dashboard_url(False, "not_configured"))

    try:
        state = _make_state(org_id)
    except Exception as exc:
        log.error("linkedin_connect_state_failed", error=str(exc))
        return RedirectResponse(_dashboard_url(False, "not_configured"))
    params = urlencode({
        "response_type": "code",
        "client_id":     settings.linkedin_client_id,
        "redirect_uri":  _callback_url(),
        "state":         state,
        "scope":         _SCOPES,
    })
    auth_url = f"{_AUTHORIZE_URL}?{params}"

    log.info("linkedin_oauth_initiated", org_id=str(org_id))
    return RedirectResponse(auth_url, status_code=302)


# ── Route 2: /growth/oauth/linkedin/callback ─────────────────────────────────

@router.get("/callback")
async def linkedin_callback(
    code: str | None  = Query(None),
    state: str | None = Query(None),
    error: str | None = Query(None),
    error_description: str | None = Query(None),
    pool: asyncpg.Pool = Depends(get_pool),
) -> RedirectResponse:
    """
    LinkedIn redirects here after user grants (or denies) access.

    1. Handle user-denied or error case.
    2. Decrypt state → org_id (CSRF protection).
    3. Exchange authorization code for access + refresh tokens.
    4. Fetch /v2/userinfo → person URN, name, email.
    5. Upsert growth.social_accounts (encrypted tokens).
    6. Redirect browser back to Growth Dashboard.
    """
    # ── 1. User denied or LinkedIn error ─────────────────────────────────────
    if error:
        log.warning("linkedin_oauth_denied", error=error, description=error_description)
        return RedirectResponse(_dashboard_url(False, "access_denied"))

    if not code or not state:
        return RedirectResponse(_dashboard_url(False, "missing_params"))

    # ── 2. Decode state → org_id ─────────────────────────────────────────────
    try:
        org_id = _decode_state(state)
    except ValueError as exc:
        log.warning("linkedin_oauth_bad_state", detail=str(exc))
        return RedirectResponse(_dashboard_url(False, "invalid_state"))

    # ── 3. Exchange code for tokens ───────────────────────────────────────────
    async with AsyncClient(timeout=20.0) as http:
        token_res = await http.post(
            _TOKEN_URL,
            data={
                "grant_type":    "authorization_code",
                "code":          code,
                "redirect_uri":  _callback_url(),
                "client_id":     settings.linkedin_client_id,
                "client_secret": settings.linkedin_client_secret,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )

    if token_res.status_code != 200:
        log.error(
            "linkedin_token_exchange_failed",
            status=token_res.status_code,
            org_id=str(org_id),
        )
        return RedirectResponse(_dashboard_url(False, "token_exchange_failed"))

    token_data = token_res.json()
    access_token   = token_data.get("access_token", "")
    refresh_token  = token_data.get("refresh_token")          # may be absent
    expires_in_sec = token_data.get("expires_in", 5184000)    # default 60 days

    if not access_token:
        log.error("linkedin_token_exchange_empty", org_id=str(org_id))
        return RedirectResponse(_dashboard_url(False, "token_exchange_failed"))

    token_expires_at = datetime.now(tz=timezone.utc) + timedelta(seconds=int(expires_in_sec))

    # ── 4. Fetch LinkedIn person URN + display name ───────────────────────────
    async with AsyncClient(timeout=15.0) as http:
        userinfo_res = await http.get(
            _USERINFO_URL,
            headers={"Authorization": f"Bearer {access_token}"},
        )

    if userinfo_res.status_code != 200:
        log.error(
            "linkedin_userinfo_failed",
            status=userinfo_res.status_code,
            org_id=str(org_id),
        )
        return RedirectResponse(_dashboard_url(False, "userinfo_failed"))

    userinfo = userinfo_res.json()

    # person URN from the `sub` claim of OpenID Connect — format: "urn:li:person:ABC123"
    # publishers/linkedin.py requires this full URN as the author in UGC Posts v2.
    person_urn = userinfo.get("sub", "")
    if not person_urn:
        log.error("linkedin_userinfo_missing_sub", org_id=str(org_id))
        return RedirectResponse(_dashboard_url(False, "userinfo_failed"))

    display_name = userinfo.get("name") or userinfo.get("given_name", "LinkedIn Account")
    email        = userinfo.get("email", "")
    picture_url  = userinfo.get("picture", "")

    log.info(
        "linkedin_oauth_success",
        org_id=str(org_id),
        display_name=display_name,
        person_urn_prefix=person_urn[:20],  # partial log only
    )

    # ── 5. Encrypt tokens + upsert social_accounts ────────────────────────────
    try:
        access_token_enc  = encrypt_token(access_token)
        refresh_token_enc = encrypt_token(refresh_token) if refresh_token else None
    except Exception:
        log.error("linkedin_token_encryption_failed", org_id=str(org_id))
        return RedirectResponse(_dashboard_url(False, "encryption_failed"))

    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO growth.social_accounts (
                org_id, platform, platform_account_id, display_name,
                access_token_enc, refresh_token_enc, token_expires_at,
                status, publish_capable, engage_capable,
                publish_status_reason, engage_status_reason,
                scopes_json, meta_json, updated_at
            ) VALUES (
                $1, 'linkedin', $2, $3,
                $4, $5, $6,
                'connected', true, true,
                'ok', 'ok',
                $7, $8, now()
            )
            ON CONFLICT (org_id, platform, platform_account_id)
            DO UPDATE SET
                display_name            = EXCLUDED.display_name,
                access_token_enc        = EXCLUDED.access_token_enc,
                refresh_token_enc       = COALESCE(EXCLUDED.refresh_token_enc, growth.social_accounts.refresh_token_enc),
                token_expires_at        = EXCLUDED.token_expires_at,
                status                  = 'connected',
                publish_capable         = true,
                engage_capable          = true,
                publish_status_reason   = 'ok',
                engage_status_reason    = 'ok',
                scopes_json             = EXCLUDED.scopes_json,
                meta_json               = EXCLUDED.meta_json,
                updated_at              = now()
            """,
            org_id,
            person_urn,
            display_name,
            access_token_enc,
            refresh_token_enc,
            token_expires_at,
            {"scopes": _SCOPES.split()},
            {"email": email, "picture": picture_url},
        )

    log.info(
        "linkedin_account_stored",
        org_id=str(org_id),
        person_urn_prefix=person_urn[:20],
    )

    # ── 6. Redirect back to Growth Dashboard ─────────────────────────────────
    return RedirectResponse(_dashboard_url(True))


# ── Route 3: DELETE /growth/oauth/linkedin — disconnect ─────────────────────

@router.delete("")
async def linkedin_disconnect(
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict:
    """
    Disconnect LinkedIn — sets status to 'disconnected', clears capability flags.
    Does NOT delete the row (preserves publish history).
    JWT required in Authorization header (standard Growth Engine pattern).
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
            WHERE org_id = $1
              AND platform = 'linkedin'
              AND status != 'disconnected'
            """,
            auth.org_id,
        )

    affected = int(result.split()[-1]) if result else 0
    log.info("linkedin_disconnected", org_id=str(auth.org_id), rows_updated=affected)

    return {
        "disconnected": affected > 0,
        "message": "LinkedIn account disconnected." if affected > 0 else "No active LinkedIn account found.",
    }
