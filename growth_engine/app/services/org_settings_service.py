"""
Org Growth Settings service — CRUD for growth.org_growth_settings.

One settings row per org (unique on org_id).
Settings control posting mode, plan keys, and engagement configuration.
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Optional

import asyncpg

from app.logging_config import get_logger
from app.models.org_settings import (
    OrgGrowthSettingsCreate,
    OrgGrowthSettingsOut,
    OrgGrowthSettingsUpdate,
)

log = get_logger(__name__)


def _row_to_out(row: asyncpg.Record) -> OrgGrowthSettingsOut:
    data = dict(row)
    jsonb_fields = ["posting_windows_json", "platform_distribution_json", "engagement_targets_json"]
    for field in jsonb_fields:
        val = data.get(field)
        if isinstance(val, str):
            data[field] = json.loads(val)
    return OrgGrowthSettingsOut(**data)


async def get_org_settings(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
) -> Optional[OrgGrowthSettingsOut]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM growth.org_growth_settings WHERE org_id = $1",
            org_id,
        )
    return _row_to_out(row) if row else None


async def create_org_settings(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    data: OrgGrowthSettingsCreate,
) -> OrgGrowthSettingsOut:
    """
    Create settings for org. Raises asyncpg.UniqueViolationError if already exists.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO growth.org_growth_settings (
                org_id, posting_mode, approval_required,
                daily_content_piece_limit, daily_engagement_limit,
                max_connected_platforms, plan_key, engagement_plan_key,
                timezone,
                posting_windows_json, platform_distribution_json, engagement_targets_json,
                auto_engagement_enabled, auto_safe_threshold, risk_block_threshold
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9,
                $10::jsonb, $11::jsonb, $12::jsonb,
                $13, $14, $15
            )
            RETURNING *
            """,
            org_id,
            data.posting_mode,
            data.approval_required,
            data.daily_content_piece_limit,
            data.daily_engagement_limit,
            data.max_connected_platforms,
            data.plan_key,
            data.engagement_plan_key,
            data.timezone,
            json.dumps(data.posting_windows_json) if data.posting_windows_json else None,
            json.dumps(data.platform_distribution_json) if data.platform_distribution_json else None,
            json.dumps(data.engagement_targets_json) if data.engagement_targets_json else None,
            data.auto_engagement_enabled,
            data.auto_safe_threshold,
            data.risk_block_threshold,
        )

    log.info("org_growth_settings_created", org_id=str(org_id), plan=data.plan_key)
    return _row_to_out(row)


async def update_org_settings(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    data: OrgGrowthSettingsUpdate,
) -> Optional[OrgGrowthSettingsOut]:
    updates: list[str] = []
    values: list[Any] = []
    idx = 1

    scalar_fields = [
        "posting_mode", "approval_required", "daily_content_piece_limit",
        "daily_engagement_limit", "max_connected_platforms", "plan_key",
        "engagement_plan_key", "timezone", "auto_engagement_enabled",
        "auto_safe_threshold", "risk_block_threshold",
    ]
    jsonb_fields = [
        "posting_windows_json", "platform_distribution_json", "engagement_targets_json",
    ]

    for field in scalar_fields:
        val = getattr(data, field, None)
        if val is not None:
            updates.append(f"{field} = ${idx}")
            values.append(val)
            idx += 1

    for field in jsonb_fields:
        val = getattr(data, field, None)
        if val is not None:
            updates.append(f"{field} = ${idx}::jsonb")
            values.append(json.dumps(val))
            idx += 1

    if not updates:
        return await get_org_settings(pool, org_id)

    updates.append("updated_at = now()")
    values.append(org_id)

    query = f"""
        UPDATE growth.org_growth_settings
        SET {', '.join(updates)}
        WHERE org_id = ${idx}
        RETURNING *
    """

    async with pool.acquire() as conn:
        row = await conn.fetchrow(query, *values)

    if row is None:
        return None

    log.info("org_growth_settings_updated", org_id=str(org_id))
    return _row_to_out(row)
