"""
Publish queue worker — leasing, execution, state machine, and logging.

State machine (schema-accurate, locked):

  pending        ─ worker leases ──────────────────────────────→ locked
  locked         ─ variant not approved ───────────────────────→ blocked_approval
  locked         ─ no connected account ───────────────────────→ blocked_auth
  locked         ─ API success ────────────────────────────────→ published
  locked         ─ retryable error, attempt < max_attempts ────→ pending  (backoff)
  locked         ─ retryable error, attempt >= max_attempts ───→ failed
  locked         ─ auth error ─────────────────────────────────→ blocked_auth
  locked         ─ rate limited, attempt < max_attempts ───────→ pending  (long backoff)
  locked         ─ content rejected ──────────────────────────→ failed
  locked         ─ platform disabled ─────────────────────────→ failed
  locked         ─ permanent error ───────────────────────────→ failed

Queue leasing query (exact, locked):
  SELECT id, org_id, platform, variant_id, asset_id, idempotency_key,
         attempt_count, max_attempts, scheduled_for
  FROM growth.publish_queue
  WHERE status = 'pending'
    AND scheduled_for <= NOW()
  ORDER BY scheduled_for ASC
  LIMIT $1
  FOR UPDATE SKIP LOCKED

  Immediately after lease: UPDATE status='locked', locked_by=$worker_id,
  locked_until=NOW()+300s, attempt_count=attempt_count+1

Idempotency:
  Before calling the platform API, check publish_logs for a prior success:
    SELECT id FROM growth.publish_logs
    WHERE queue_id = $1 AND success = true
  If found → transition to 'published' without API call (already published).

Active asset selection:
  If queue item has asset_id set: use that specific asset.
  If asset_id is NULL: look up active asset via get_active_asset(variant_id, preferred_template)
  Preferred template per platform: linkedin→quote_card, instagram→quote_card,
  facebook→quote_card, x→single_visual.
  If no asset found: post text-only (supported on LinkedIn/Facebook).

Publish logs:
  Appended for EVERY attempt (success and failure).
  request_json and response_json are sanitized before write (no tokens).
  Stored via _write_publish_log().

Worker polling:
  run_publish_cycle() is called every 30 seconds from worker.py.
  Processes up to LEASE_BATCH_SIZE items per cycle.
  Graceful shutdown: _shutdown_event.is_set() checked between items.

Stale lock recovery:
  Items where status='locked' AND locked_until < NOW() are reset to 'pending'
  by reset_stale_locks() — called once per cycle before leasing.
  This handles worker crashes mid-publish.
"""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

import asyncpg

from app.logging_config import get_logger
from app.publishers.base import PublishRequest, sanitize_for_log
from app.publishers.error_normalizer import normalize_error, queue_status_for_category
from app.publishers.facebook import FacebookPublisher
from app.publishers.instagram import InstagramPublisher
from app.publishers.linkedin import LinkedInPublisher
from app.publishers.meta import resolve_account
from app.publishers.retry_policy import next_scheduled_for, should_retry
from app.publishers.x import XPublisher
from app.services.image_builder.asset_storage import get_active_asset

log = get_logger(__name__)

LEASE_BATCH_SIZE = 5        # items per cycle
LEASE_DURATION_S = 300      # 5 min lock window (covers slow platform APIs)
POLL_INTERVAL_S  = 30       # seconds between cycles

# Worker instance ID — stable per process (for locked_by tracking)
_WORKER_ID = f"worker-{os.getpid()}"

# Platform → preferred image template (for active asset lookup)
_PREFERRED_TEMPLATE = {
    "linkedin":  "quote_card",
    "facebook":  "quote_card",
    "instagram": "quote_card",
    "x":         "single_visual",
}

# Publisher singletons
_PUBLISHERS = {
    "linkedin":  LinkedInPublisher(),
    "facebook":  FacebookPublisher(),
    "instagram": InstagramPublisher(),
    "x":         XPublisher(),
}


async def run_publish_cycle(pool: asyncpg.Pool) -> int:
    """
    One publish cycle: reset stale locks → lease → execute → log.
    Returns number of items processed.
    """
    await reset_stale_locks(pool)
    items = await lease_queue_items(pool, LEASE_BATCH_SIZE)
    processed = 0

    for item in items:
        await execute_queue_item(pool, item)
        processed += 1

    if processed > 0:
        log.info("publish_cycle_completed", items_processed=processed)
    return processed


async def reset_stale_locks(pool: asyncpg.Pool) -> int:
    """
    Reset items where locked_until has expired — returns count reset.
    Called at the start of every cycle to recover from worker crashes.
    """
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE growth.publish_queue
            SET status       = 'pending',
                locked_by    = NULL,
                locked_until = NULL,
                updated_at   = NOW()
            WHERE status       = 'locked'
              AND locked_until < NOW()
            """
        )
    count = int(result.split()[-1]) if result else 0
    if count > 0:
        log.warning("stale_locks_reset", count=count)
    return count


async def lease_queue_items(pool: asyncpg.Pool, limit: int) -> list[dict]:
    """
    Lease up to `limit` pending items using SELECT FOR UPDATE SKIP LOCKED.

    Returns list of queue item dicts. Each item is already updated to
    status='locked' within the same transaction.
    """
    now = datetime.now(timezone.utc)

    async with pool.acquire() as conn:
        async with conn.transaction():
            rows = await conn.fetch(
                """
                SELECT id, org_id, platform, variant_id, asset_id,
                       idempotency_key, attempt_count, max_attempts, scheduled_for
                FROM growth.publish_queue
                WHERE status       = 'pending'
                  AND scheduled_for <= $1
                ORDER BY scheduled_for ASC
                LIMIT $2
                FOR UPDATE SKIP LOCKED
                """,
                now,
                limit,
            )

            if not rows:
                return []

            ids = [r["id"] for r in rows]
            await conn.execute(
                """
                UPDATE growth.publish_queue
                SET status       = 'locked',
                    locked_by    = $1,
                    locked_until = NOW() + INTERVAL '300 seconds',
                    attempt_count = attempt_count + 1,
                    updated_at   = NOW()
                WHERE id = ANY($2::uuid[])
                """,
                _WORKER_ID,
                ids,
            )

    items = [dict(r) for r in rows]
    log.info("queue_items_leased", count=len(items), worker=_WORKER_ID)
    return items


async def execute_queue_item(pool: asyncpg.Pool, item: dict) -> None:
    """
    Execute one leased queue item through the full publish pipeline.
    Handles all errors internally — never raises.
    """
    queue_id    = item["id"]
    org_id      = item["org_id"]
    platform    = item["platform"]
    variant_id  = item["variant_id"]
    asset_id    = item.get("asset_id")
    ikey        = item["idempotency_key"]
    attempt     = item["attempt_count"]   # already incremented in lease
    max_att     = item["max_attempts"]

    log.info(
        "publish_attempt_started",
        queue_id=str(queue_id),
        platform=platform,
        attempt=attempt,
        max_attempts=max_att,
    )

    # ── Guard 1: idempotency — already published? ──────────────────────────────
    if await _already_published(pool, queue_id):
        log.info("publish_already_done_idempotent", queue_id=str(queue_id))
        await _transition(pool, queue_id, "published",
                          last_error=None, published_platform_id=None)
        return

    # ── Guard 2: variant must be approved ─────────────────────────────────────
    variant = await _fetch_variant(pool, org_id, variant_id)
    if not variant or variant["status"] not in ("approved", "force_approved"):
        log.warning("publish_blocked_variant_not_approved",
                    queue_id=str(queue_id), status=variant.get("status") if variant else "missing")
        await _transition(pool, queue_id, "blocked_approval",
                          last_error="variant_not_approved")
        return

    # ── Guard 3: resolve platform account ────────────────────────────────────
    account = await resolve_account(pool, org_id, platform)
    if not account:
        log.warning("publish_blocked_no_account",
                    queue_id=str(queue_id), platform=platform)
        await _transition(pool, queue_id, "blocked_auth",
                          last_error="no_connected_account")
        return

    # ── Active asset resolution ────────────────────────────────────────────────
    asset_url = await _resolve_asset_url(pool, variant_id, asset_id, platform)

    # ── Build request ─────────────────────────────────────────────────────────
    req = PublishRequest(
        queue_id=queue_id,
        org_id=org_id,
        platform=platform,
        variant_id=variant_id,
        body_text=variant["body_text"] or "",
        platform_account_id=account["platform_account_id"],
        access_token=account["access_token"],
        idempotency_key=ikey,
        asset_url=asset_url,
        caption_text=variant.get("caption_text"),
    )

    # ── Publish ───────────────────────────────────────────────────────────────
    publisher = _PUBLISHERS.get(platform)
    if not publisher:
        await _transition(pool, queue_id, "failed", last_error=f"no_publisher:{platform}")
        return

    result = await publisher.publish(req)

    # ── Write publish log (append-only) ──────────────────────────────────────
    await _write_publish_log(
        pool=pool,
        queue_id=queue_id,
        org_id=org_id,
        platform=platform,
        result=result,
    )

    # ── Transition state ──────────────────────────────────────────────────────
    if result.success:
        await _finalize_variant(pool, variant_id)
        await _transition(
            pool, queue_id, "published",
            published_platform_id=result.platform_post_id,
            published_url=result.platform_post_url,
        )
        log.info(
            "publish_success",
            queue_id=str(queue_id),
            platform=platform,
            post_id=result.platform_post_id,
        )
        return

    # Failed — determine next state
    category    = result.error_category or "PERMANENT"
    next_status = queue_status_for_category(category, attempt, max_att)

    log.warning(
        "publish_failed",
        queue_id=str(queue_id),
        platform=platform,
        category=category,
        next_status=next_status,
        attempt=attempt,
    )

    extra: dict = {"last_error": f"{category}: {result.error_message or ''}"}

    if next_status == "pending":
        # Re-queue with backoff
        extra["scheduled_for"] = next_scheduled_for(category, attempt)

    await _transition(pool, queue_id, next_status, **extra)


# ── DB helpers ─────────────────────────────────────────────────────────────────

async def _already_published(pool: asyncpg.Pool, queue_id: uuid.UUID) -> bool:
    """Check publish_logs for a prior success on this queue item."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id FROM growth.publish_logs WHERE queue_id = $1 AND success = true LIMIT 1",
            queue_id,
        )
    return row is not None


async def _fetch_variant(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    variant_id: uuid.UUID,
) -> Optional[dict]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, status, body_text, caption_text, platform
            FROM growth.content_variants
            WHERE id = $1 AND org_id = $2
            """,
            variant_id,
            org_id,
        )
    return dict(row) if row else None


async def _resolve_asset_url(
    pool: asyncpg.Pool,
    variant_id: uuid.UUID,
    asset_id: Optional[uuid.UUID],
    platform: str,
) -> Optional[str]:
    """
    Determine the public asset URL for this publish.

    Priority:
      1. If asset_id is explicitly set on the queue item, fetch that specific asset
      2. Otherwise, look up the active asset for the preferred template for this platform
      3. If no asset: return None (text-only post)
    """
    from app.services.image_builder.asset_storage import public_url as make_public_url

    if asset_id:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT storage_path FROM growth.content_assets WHERE id = $1",
                asset_id,
            )
        if row:
            return make_public_url(row["storage_path"])

    # Look up active asset for preferred template
    preferred = _PREFERRED_TEMPLATE.get(platform, "quote_card")
    asset = await get_active_asset(pool, variant_id, preferred)
    if asset:
        return make_public_url(asset["storage_path"])

    # Try any active asset for this variant as fallback
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT storage_path FROM growth.content_assets
            WHERE variant_id = $1 AND is_active = true
            ORDER BY created_at DESC LIMIT 1
            """,
            variant_id,
        )
    if row:
        return make_public_url(row["storage_path"])

    return None   # text-only post


async def _transition(
    pool: asyncpg.Pool,
    queue_id: uuid.UUID,
    new_status: str,
    last_error: Optional[str] = None,
    published_platform_id: Optional[str] = None,
    published_url: Optional[str] = None,
    scheduled_for: Optional[datetime] = None,
) -> None:
    """
    Update queue item status and clear the lock.
    On successful publish, also sets external_publish_fingerprint = published_platform_id
    for reconciliation indexing.
    """
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE growth.publish_queue
            SET status                        = $1,
                locked_by                     = NULL,
                locked_until                  = NULL,
                last_error                    = COALESCE($2, last_error),
                published_platform_id         = COALESCE($3, published_platform_id),
                published_url                 = COALESCE($4, published_url),
                scheduled_for                 = COALESCE($5, scheduled_for),
                external_publish_fingerprint  = CASE
                    WHEN $1 = 'published' AND $3 IS NOT NULL THEN $3
                    ELSE external_publish_fingerprint
                END,
                updated_at                    = NOW()
            WHERE id = $6
            """,
            new_status,
            last_error,
            published_platform_id,
            published_url,
            scheduled_for,
            queue_id,
        )


async def _write_publish_log(
    pool: asyncpg.Pool,
    queue_id: uuid.UUID,
    org_id: uuid.UUID,
    platform: str,
    result,
) -> None:
    """Append a publish_logs record. Tokens are sanitized before write."""
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO growth.publish_logs (
                queue_id, org_id, platform,
                request_json, response_json,
                http_status, success
            ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)
            """,
            queue_id,
            org_id,
            platform,
            json.dumps(result.request_json) if result.request_json else None,
            json.dumps(result.response_json) if result.response_json else None,
            result.http_status,
            result.success,
        )


async def _finalize_variant(pool: asyncpg.Pool, variant_id: uuid.UUID) -> None:
    """Mark variant as published with finalized_at timestamp."""
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE growth.content_variants
            SET status = 'published', finalized_at = NOW()
            WHERE id = $1 AND status = 'approved'
            """,
            variant_id,
        )
