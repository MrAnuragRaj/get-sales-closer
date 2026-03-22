"""
Publish queue API routes.

Routes:
  GET  /growth/queue              — list queue items (filterable by status/platform)
  POST /growth/queue              — enqueue a variant for publishing
  GET  /growth/queue/{id}         — single queue item detail
  DELETE /growth/queue/{id}       — cancel a pending queue item
  GET  /growth/queue/{id}/logs    — publish attempt logs for a queue item

All routes are org-scoped via JWT.
Pagination: limit/offset on list endpoints (max 100).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query

from app.auth_bridge import AuthContext, require_auth
from app.db import get_pool
from app.models.queue import (
    EnqueueRequest,
    PublishLogListResponse,
    PublishLogOut,
    QueueItemOut,
    QueueListResponse,
)

router = APIRouter(prefix="/queue", tags=["queue"])


# ── List queue items ────────────────────────────────────────────────────────────

@router.get("", response_model=QueueListResponse)
async def list_queue_items(
    status: Optional[str] = Query(None, description="Filter by status"),
    platform: Optional[str] = Query(None, description="Filter by platform"),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    org_id = auth.org_id

    filters = ["org_id = $1"]
    params: list = [org_id]
    p = 2

    if status:
        filters.append(f"status = ${p}")
        params.append(status)
        p += 1
    if platform:
        filters.append(f"platform = ${p}")
        params.append(platform)
        p += 1

    where = " AND ".join(filters)

    async with pool.acquire() as conn:
        total_row = await conn.fetchrow(
            f"SELECT COUNT(*) AS n FROM growth.publish_queue WHERE {where}",
            *params,
        )
        rows = await conn.fetch(
            f"""
            SELECT id, org_id, platform, variant_id, asset_id,
                   idempotency_key, status, attempt_count, max_attempts,
                   scheduled_for, locked_by, locked_until,
                   last_error, published_platform_id, published_url,
                   created_at, updated_at
            FROM growth.publish_queue
            WHERE {where}
            ORDER BY scheduled_for ASC
            LIMIT ${p} OFFSET ${p + 1}
            """,
            *params,
            limit,
            offset,
        )

    return QueueListResponse(
        items=[QueueItemOut(**dict(r)) for r in rows],
        total=total_row["n"],
    )


# ── Enqueue a variant ───────────────────────────────────────────────────────────

@router.post("", response_model=QueueItemOut, status_code=201)
async def enqueue_variant(
    body: EnqueueRequest,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    org_id = auth.org_id

    # Verify the variant belongs to this org and is in a publishable state
    async with pool.acquire() as conn:
        variant = await conn.fetchrow(
            """
            SELECT id, status FROM growth.content_variants
            WHERE id = $1 AND org_id = $2
            """,
            body.variant_id,
            org_id,
        )
        if not variant:
            raise HTTPException(404, "variant_not_found")
        if variant["status"] not in ("approved", "force_approved"):
            raise HTTPException(
                422,
                f"variant_not_publishable: status={variant['status']}. "
                "Only approved or force_approved variants can be queued."
            )

        scheduled = body.scheduled_for or datetime.now(timezone.utc)
        ikey = f"{body.variant_id}:{body.platform}:{scheduled.isoformat()}"

        try:
            row = await conn.fetchrow(
                """
                INSERT INTO growth.publish_queue (
                    org_id, platform, variant_id, asset_id,
                    idempotency_key, status, attempt_count, max_attempts,
                    scheduled_for
                ) VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6, $7)
                ON CONFLICT (idempotency_key) DO UPDATE
                    SET updated_at = NOW()
                RETURNING id, org_id, platform, variant_id, asset_id,
                          idempotency_key, status, attempt_count, max_attempts,
                          scheduled_for, locked_by, locked_until,
                          last_error, published_platform_id, published_url,
                          created_at, updated_at
                """,
                org_id,
                body.platform,
                body.variant_id,
                body.asset_id,
                ikey,
                body.max_attempts,
                scheduled,
            )
        except asyncpg.UniqueViolationError:
            # Race condition — fetch the existing row
            row = await conn.fetchrow(
                """
                SELECT id, org_id, platform, variant_id, asset_id,
                       idempotency_key, status, attempt_count, max_attempts,
                       scheduled_for, locked_by, locked_until,
                       last_error, published_platform_id, published_url,
                       created_at, updated_at
                FROM growth.publish_queue
                WHERE idempotency_key = $1
                """,
                ikey,
            )

    return QueueItemOut(**dict(row))


# ── Get single queue item ───────────────────────────────────────────────────────

@router.get("/{queue_id}", response_model=QueueItemOut)
async def get_queue_item(
    queue_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    org_id = auth.org_id

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, org_id, platform, variant_id, asset_id,
                   idempotency_key, status, attempt_count, max_attempts,
                   scheduled_for, locked_by, locked_until,
                   last_error, published_platform_id, published_url,
                   created_at, updated_at
            FROM growth.publish_queue
            WHERE id = $1 AND org_id = $2
            """,
            queue_id,
            org_id,
        )

    if not row:
        raise HTTPException(404, "queue_item_not_found")
    return QueueItemOut(**dict(row))


# ── Cancel a pending queue item ─────────────────────────────────────────────────

@router.delete("/{queue_id}", status_code=204)
async def cancel_queue_item(
    queue_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    org_id = auth.org_id

    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE growth.publish_queue
            SET status = 'cancelled', updated_at = NOW()
            WHERE id = $1 AND org_id = $2 AND status = 'pending'
            """,
            queue_id,
            org_id,
        )

    # result is "UPDATE N"
    count = int(result.split()[-1]) if result else 0
    if count == 0:
        # Check if it exists at all
        async with pool.acquire() as conn:
            exists = await conn.fetchrow(
                "SELECT status FROM growth.publish_queue WHERE id = $1 AND org_id = $2",
                queue_id, org_id,
            )
        if not exists:
            raise HTTPException(404, "queue_item_not_found")
        raise HTTPException(
            409,
            f"cannot_cancel: item is in status={exists['status']} (only pending items can be cancelled)"
        )


# ── Publish logs for a queue item ───────────────────────────────────────────────

@router.get("/{queue_id}/logs", response_model=PublishLogListResponse)
async def get_publish_logs(
    queue_id: uuid.UUID,
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    org_id = auth.org_id

    async with pool.acquire() as conn:
        # Verify ownership
        queue_row = await conn.fetchrow(
            "SELECT id FROM growth.publish_queue WHERE id = $1 AND org_id = $2",
            queue_id, org_id,
        )
        if not queue_row:
            raise HTTPException(404, "queue_item_not_found")

        total_row = await conn.fetchrow(
            "SELECT COUNT(*) AS n FROM growth.publish_logs WHERE queue_id = $1",
            queue_id,
        )
        rows = await conn.fetch(
            """
            SELECT id, queue_id, org_id, platform,
                   http_status, success,
                   request_json, response_json,
                   created_at
            FROM growth.publish_logs
            WHERE queue_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3
            """,
            queue_id,
            limit,
            offset,
        )

    return PublishLogListResponse(
        logs=[PublishLogOut(**dict(r)) for r in rows],
        total=total_row["n"],
    )
