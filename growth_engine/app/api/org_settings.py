"""
Org Growth Settings API routes.

GET  /growth/settings          — fetch settings for caller's org
POST /growth/settings          — create settings (org must not have any yet)
PUT  /growth/settings          — update settings (partial)
GET  /growth/settings/quota    — today's quota usage summary (dashboard display)
"""

from __future__ import annotations

from datetime import date, timezone

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status

from app.auth_bridge import AuthContext, require_auth
from app.db import get_pool
from app.models.org_settings import (
    OrgGrowthSettingsCreate,
    OrgGrowthSettingsOut,
    OrgGrowthSettingsUpdate,
)
from app.quotas import get_usage_summary
from app.services import org_settings_service
from app.logging_config import get_logger

log = get_logger(__name__)
router = APIRouter(prefix="/settings", tags=["Org Growth Settings"])


@router.get("", response_model=OrgGrowthSettingsOut)
async def get_settings(
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
) -> OrgGrowthSettingsOut:
    settings = await org_settings_service.get_org_settings(pool, auth.org_id)
    if settings is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Growth settings not configured. Create them with POST /growth/settings.",
        )
    return settings


@router.post("", response_model=OrgGrowthSettingsOut, status_code=status.HTTP_201_CREATED)
async def create_settings(
    body: OrgGrowthSettingsCreate,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
) -> OrgGrowthSettingsOut:
    try:
        return await org_settings_service.create_org_settings(pool, auth.org_id, body)
    except asyncpg.UniqueViolationError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Growth settings already exist. Use PUT to update.",
        )


@router.put("", response_model=OrgGrowthSettingsOut)
async def update_settings(
    body: OrgGrowthSettingsUpdate,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
) -> OrgGrowthSettingsOut:
    updated = await org_settings_service.update_org_settings(pool, auth.org_id, body)
    if updated is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Growth settings not found. Create them first with POST /growth/settings.",
        )
    return updated


@router.get("/quota")
async def get_quota_summary(
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict:
    """
    Returns today's quota usage summary for dashboard display.
    Shows content pieces, engagement, and free generation usage.
    """
    today = date.today()
    return await get_usage_summary(pool, auth.org_id, today)
