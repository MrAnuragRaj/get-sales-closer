"""
Auth bridge: validates Supabase-issued JWTs and resolves organization context.

──────────────────────────────────────────────────────────────────────────────
ORG RESOLUTION PRECEDENCE — exact and deterministic
──────────────────────────────────────────────────────────────────────────────

The sole source of truth for user↔org binding is public.org_members.
There is no fallback to any other table. There is no "guess from organizations".

Resolution steps:
  1. Verify JWT (HS256, aud="authenticated", using SUPABASE_JWT_SECRET).
  2. Extract user_id from `sub` claim.
  3. Query public.org_members WHERE user_id = $1.
     If multiple rows exist (a user can belong to multiple orgs — e.g., an agent
     who is also an admin in another org), the highest-privilege role wins:
       agency_admin > enterprise_admin > enterprise_agent > any other role
     Within the same role, the row with the earliest created_at is selected
     (deterministic tiebreaker — never random).
  4. If no org_members row exists → HTTP 403.
     This means the user has not completed onboarding. There is no hidden default.

Why no fallback to public.organizations:
  - The organizations table has no owner_id column in the GSC schema.
  - Any attempt to guess an org from another table risks binding a user to
    the wrong org in a multi-tenant system.
  - Users without an org_members row have not completed onboarding and must
    not be granted access to the Growth Engine.

This makes the resolution fully deterministic:
  - Same user always gets the same org_id unless their org_members rows change.
  - No race condition, no ambiguity, no hidden defaulting.
──────────────────────────────────────────────────────────────────────────────

Flow per request:
  1. Extract Bearer token from Authorization header.
  2. Verify JWT.
  3. Query public.org_members with priority ordering → LIMIT 1.
  4. Return AuthContext(user_id, org_id, role, email).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Optional

import asyncpg
import jwt as pyjwt
from jwt import PyJWKClient
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import settings
from app.db import get_pool
from app.logging_config import get_logger

log = get_logger(__name__)

_bearer = HTTPBearer(auto_error=True)

# ── JWKS client — cached, refreshes every hour ─────────────────────────────
# Supabase new projects use ES256 (P-256 ECC asymmetric keys).
# PyJWKClient fetches the public keys from the JWKS endpoint and caches them.
# Falls back to legacy HS256 secret if JWKS verification fails (older projects).
_jwks_client: PyJWKClient | None = None


def _get_jwks_client() -> PyJWKClient | None:
    global _jwks_client
    if _jwks_client is None and settings.supabase_url:
        jwks_url = f"{settings.supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"
        try:
            _jwks_client = PyJWKClient(jwks_url, cache_jwk_set=True, lifespan=3600)
        except Exception as exc:
            log.warning("jwks_client_init_failed", error=str(exc))
    return _jwks_client


def _decode_jwt(token: str) -> dict:
    """
    Decode and verify a Supabase JWT.

    Strategy — driven by the JWT header's `alg` claim:
      - ES256 / RS256 → JWKS only (asymmetric; HS256 fallback always fails for these)
      - HS256          → shared secret only (legacy Supabase projects)

    Both paths verify audience='authenticated' and expiry.
    Raises pyjwt.InvalidTokenError on any failure.
    """
    # Peek at the header to pick the right verification path
    try:
        header = pyjwt.get_unverified_header(token)
    except pyjwt.DecodeError as exc:
        raise pyjwt.InvalidTokenError(f"Malformed JWT header: {exc}") from exc

    alg = header.get("alg", "")
    log.debug("jwt_decode_attempt", alg=alg)

    # ── Asymmetric tokens (ES256 / RS256) — new Supabase projects ────────────
    # Never fall back to HS256 for asymmetric tokens — it will always fail.
    if alg in ("ES256", "RS256"):
        jwks = _get_jwks_client()
        if not jwks:
            log.error("jwks_client_unavailable", hint="Set SUPABASE_URL in Railway env vars")
            raise pyjwt.InvalidTokenError(
                "JWKS client not initialized. Ensure SUPABASE_URL is set in Railway."
            )
        try:
            signing_key = jwks.get_signing_key_from_jwt(token)
            return pyjwt.decode(
                token,
                signing_key.key,
                algorithms=["ES256", "RS256"],
                audience="authenticated",
            )
        except pyjwt.ExpiredSignatureError:
            raise
        except Exception as exc:
            log.error(
                "jwks_verification_failed",
                alg=alg,
                error=str(exc),
                error_type=type(exc).__name__,
            )
            raise pyjwt.InvalidTokenError(
                f"ES256/RS256 JWT verification failed: {exc}"
            ) from exc

    # ── Symmetric tokens (HS256) — legacy Supabase projects ──────────────────
    if settings.supabase_jwt_secret:
        return pyjwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
        )

    raise pyjwt.InvalidTokenError(
        "No JWT verification method available. "
        "Set SUPABASE_URL (for ES256/RS256) or SUPABASE_JWT_SECRET (legacy HS256) in Railway."
    )


@dataclass(frozen=True)
class AuthContext:
    """
    Resolved auth context for a single request. Immutable after construction.

    role is None only if the org_members.role column is NULL (rare, legacy rows).
    It will be one of: 'agency_admin', 'enterprise_admin', 'enterprise_agent',
    or None for generic members / solo owners.
    """
    user_id: uuid.UUID
    org_id: uuid.UUID
    role: Optional[str]
    email: str


async def require_auth(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
    pool: asyncpg.Pool = Depends(get_pool),
) -> AuthContext:
    """
    FastAPI dependency injected into every protected route.

    Raises HTTP 401 on invalid/expired token.
    Raises HTTP 403 if user has no org_members row (not onboarded).

    Usage:
        @router.get("/brand")
        async def get_brand(auth: AuthContext = Depends(require_auth)):
            ...
    """
    token = credentials.credentials

    # ── Step 1: Verify JWT (ES256 via JWKS, fallback to legacy HS256) ────────
    try:
        payload = _decode_jwt(token)
    except pyjwt.ExpiredSignatureError:
        log.warning("auth_failed", reason="token_expired")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token expired. Please sign in again.",
        )
    except pyjwt.InvalidTokenError as exc:
        log.warning("auth_failed", reason="invalid_token", error_type=type(exc).__name__)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token.",
        )

    # ── Step 2: Extract user_id ────────────────────────────────────────────
    user_id_str = payload.get("sub")
    email = payload.get("email", "")

    if not user_id_str:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token is missing the 'sub' claim.",
        )
    try:
        user_id = uuid.UUID(user_id_str)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token contains an invalid user ID format.",
        )

    # ── Step 3: Resolve org — public.org_members is the only source of truth ──
    #
    # Priority ordering (deterministic):
    #   1. agency_admin      (highest privilege)
    #   2. enterprise_admin
    #   3. enterprise_agent
    #   4. any other role / NULL role
    #
    # Tiebreaker within same role: earliest created_at (stable, not random).
    # LIMIT 1 ensures exactly one row is selected.
    #
    # If a user has no org_members row → they have not completed onboarding.
    # No fallback. No guessing. HTTP 403.
    row = await pool.fetchrow(
        """
        SELECT om.org_id, om.role
        FROM public.org_members om
        WHERE om.user_id = $1
        ORDER BY
            CASE om.role
                WHEN 'agency_admin'     THEN 1
                WHEN 'enterprise_admin' THEN 2
                WHEN 'enterprise_agent' THEN 3
                ELSE 4
            END ASC
        LIMIT 1
        """,
        user_id,
    )

    if row is None:
        log.warning(
            "auth_failed",
            reason="no_org_membership",
            user_id=str(user_id),
            hint="User has no org_members row — onboarding incomplete or account not set up",
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "No organization membership found for this account. "
                "Complete onboarding at getsalescloser.com before using the Growth Engine."
            ),
        )

    org_id: uuid.UUID = row["org_id"]
    role: Optional[str] = row["role"]

    log.debug(
        "auth_resolved",
        user_id=str(user_id),
        org_id=str(org_id),
        role=role,
    )
    return AuthContext(user_id=user_id, org_id=org_id, role=role, email=email)
