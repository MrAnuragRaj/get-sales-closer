"""
Engagement targets CRUD — who/what to monitor for engagement opportunities.
"""

from __future__ import annotations

import uuid
from typing import Optional

import asyncpg

from app.logging_config import get_logger
from app.models.engagement import EngagementTargetCreate, EngagementTargetUpdate

log = get_logger(__name__)

_TARGET_COLS = """
    id, org_id, platform, target_type, target_identifier,
    target_name, description, is_active, created_at, updated_at
"""


async def create_target(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    data: EngagementTargetCreate,
) -> Optional[dict]:
    """
    Create an engagement target.
    Returns None if the (org, platform, type, identifier) already exists.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"""
            INSERT INTO growth.engagement_targets
                (org_id, platform, target_type, target_identifier, target_name, description)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (org_id, platform, target_type, target_identifier) DO NOTHING
            RETURNING {_TARGET_COLS}
            """,
            org_id,
            data.platform,
            data.target_type,
            data.target_identifier,
            data.target_name,
            data.description,
        )
    if row:
        log.info("engagement_target_created",
                 org_id=str(org_id), platform=data.platform,
                 target_type=data.target_type, identifier=data.target_identifier)
    return dict(row) if row else None


async def list_targets(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: Optional[str] = None,
    active_only: bool = True,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """Return (rows, total_count) for an org's engagement targets."""
    conditions = ["org_id = $1"]
    params: list = [org_id]
    i = 2

    if platform:
        conditions.append(f"platform = ${i}")
        params.append(platform)
        i += 1
    if active_only:
        conditions.append("is_active = true")

    where = " AND ".join(conditions)

    async with pool.acquire() as conn:
        total = await conn.fetchval(
            f"SELECT COUNT(*) FROM growth.engagement_targets WHERE {where}",
            *params,
        )
        rows = await conn.fetch(
            f"""
            SELECT {_TARGET_COLS}
            FROM growth.engagement_targets
            WHERE {where}
            ORDER BY created_at DESC
            LIMIT ${i} OFFSET ${i+1}
            """,
            *params, limit, offset,
        )
    return [dict(r) for r in rows], total


async def get_target(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    target_id: uuid.UUID,
) -> Optional[dict]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"SELECT {_TARGET_COLS} FROM growth.engagement_targets WHERE id = $1 AND org_id = $2",
            target_id, org_id,
        )
    return dict(row) if row else None


async def update_target(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    target_id: uuid.UUID,
    data: EngagementTargetUpdate,
) -> Optional[dict]:
    """Partial update — only set fields."""
    sets = []
    params: list = []
    i = 1

    if data.target_name is not None:
        sets.append(f"target_name = ${i}"); params.append(data.target_name); i += 1
    if data.description is not None:
        sets.append(f"description = ${i}"); params.append(data.description); i += 1
    if data.is_active is not None:
        sets.append(f"is_active = ${i}"); params.append(data.is_active); i += 1

    if not sets:
        return await get_target(pool, org_id, target_id)

    sets.append("updated_at = NOW()")
    params.extend([target_id, org_id])

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"""
            UPDATE growth.engagement_targets
            SET {', '.join(sets)}
            WHERE id = ${i} AND org_id = ${i+1}
            RETURNING {_TARGET_COLS}
            """,
            *params,
        )
    return dict(row) if row else None


async def delete_target(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    target_id: uuid.UUID,
) -> bool:
    """Hard delete — cascades to opportunities."""
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM growth.engagement_targets WHERE id = $1 AND org_id = $2",
            target_id, org_id,
        )
    count = int(result.split()[-1]) if result else 0
    return count > 0
