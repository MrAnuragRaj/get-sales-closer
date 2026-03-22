"""
Brand Profile API routes.

GET  /growth/brand          — fetch brand profile for caller's org
POST /growth/brand          — create brand profile (org must not have one yet)
PUT  /growth/brand          — update brand profile (partial — only provided fields updated)

All routes require a valid Supabase JWT. Org is resolved from the auth token.
"""

from __future__ import annotations

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status

from app.auth_bridge import AuthContext, require_auth
from app.db import get_pool
from app.models.brand import BrandProfileCreate, BrandProfileOut, BrandProfileUpdate
from app.services import brand_brain
from app.logging_config import get_logger

log = get_logger(__name__)
router = APIRouter(prefix="/brand", tags=["Brand Profile"])


@router.get("", response_model=BrandProfileOut)
async def get_brand_profile(
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
) -> BrandProfileOut:
    profile = await brand_brain.get_brand_profile(pool, auth.org_id)
    if profile is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Brand profile not found. Create one first with POST /growth/brand.",
        )
    return profile


@router.post("", response_model=BrandProfileOut, status_code=status.HTTP_201_CREATED)
async def create_brand_profile(
    body: BrandProfileCreate,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
) -> BrandProfileOut:
    try:
        return await brand_brain.create_brand_profile(pool, auth.org_id, body)
    except asyncpg.UniqueViolationError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Brand profile already exists for this organization. Use PUT to update.",
        )


@router.put("", response_model=BrandProfileOut)
async def update_brand_profile(
    body: BrandProfileUpdate,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
) -> BrandProfileOut:
    updated = await brand_brain.update_brand_profile(pool, auth.org_id, body)
    if updated is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Brand profile not found. Create one first with POST /growth/brand.",
        )
    return updated
