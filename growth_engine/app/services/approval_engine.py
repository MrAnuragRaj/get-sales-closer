"""
Approval Engine — mode-aware publishing flow.

Posting modes (stored in growth.org_growth_settings.posting_mode):

  auto
    Pipeline generates → critic approves → variant saved as 'approved'
    → immediately enqueued (no human touch needed).
    Human override: force-approve a 'draft' → still auto-enqueues.

  approval
    Pipeline generates → critic approves → variant saved as 'approved'.
    Nothing enqueued until human calls POST /drafts/{id}/approve.
    Approve action → variant status 'queued' + queue entry created.
    Force-approve (critic-failed draft) → same: status 'queued' + queue entry.

  suggestion_only
    Pipeline generates → variant ALWAYS saved as 'draft' (even if critic approved).
    Auto-enqueue: NEVER.
    Human approve route: approve only (status → 'approved'), NO auto-enqueue.
    To actually publish: human must also call POST /drafts/{id}/queue explicitly.

Mode change behavior:
  Changing posting_mode has NO effect on already-queued items.
  Only the next pipeline run or next human action uses the new mode.

Variant status state machine:
  draft          — initial state (pipeline result or edit-reverted)
  approved       — critic passed (or human approved); ready for queue
  queued         — a publish_queue entry exists for this variant
  published      — worker finalized (terminal)
  failed         — publish failed at max retries (terminal)
  rejected       — human explicitly rejected (recoverable via edit)

Edit behavior:
  Editing any variant in (draft, approved, queued, needs_review):
    → body_text updated
    → is_user_edited = true
    → status → 'draft' (approval invalidated)
    → any pending queue entry → cancelled
    → ApprovalEvent(edited) logged

Force_approved:
  critic_decision='force_approved' means a human overrode the critic's 'revise'
  recommendation. It does NOT bypass the posting_mode logic:
    - auto:           force_approve → approved → auto-enqueue
    - approval:       force_approve → approved → enqueue on approve call
    - suggestion_only: force_approve → approved → no enqueue

Key functions:
  handle_pipeline_completion() — called by content_pipeline after variant saved
  handle_human_approval()      — called by POST /drafts/{id}/approve
  handle_explicit_queue()      — called by POST /drafts/{id}/queue
  handle_edit()                — called by PATCH /drafts/{id}
  handle_rejection()           — called by DELETE /drafts/{id}
  get_approval_history()       — called by GET /drafts/{id}/approval-history
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Optional

import asyncpg

from app.logging_config import get_logger

log = get_logger(__name__)


# ── Mode constants (mirror DB CHECK constraint) ─────────────────────────────────

MODE_AUTO            = "auto"
MODE_APPROVAL        = "approval"
MODE_SUGGESTION_ONLY = "suggestion_only"

_VALID_MODES = frozenset({MODE_AUTO, MODE_APPROVAL, MODE_SUGGESTION_ONLY})

# Event type constants
EVT_AUTO_QUEUED     = "auto_queued"
EVT_HUMAN_APPROVED  = "human_approved"
EVT_FORCE_APPROVED  = "force_approved"
EVT_HUMAN_QUEUED    = "human_queued"
EVT_REJECTED        = "rejected"
EVT_EDITED          = "edited"
EVT_QUEUE_CANCELLED = "queue_cancelled"
EVT_MODE_SNAPSHOT   = "mode_snapshot"


# ── Public API ──────────────────────────────────────────────────────────────────

async def get_posting_mode(pool: asyncpg.Pool, org_id: uuid.UUID) -> str:
    """
    Fetch the current posting_mode for an org.
    Returns 'suggestion_only' as the safe default if settings not found.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT posting_mode FROM growth.org_growth_settings WHERE org_id = $1",
            org_id,
        )
    if row:
        mode = row["posting_mode"]
        if mode in _VALID_MODES:
            return mode
    log.warning("posting_mode_not_found", org_id=str(org_id), default="suggestion_only")
    return MODE_SUGGESTION_ONLY


async def handle_pipeline_completion(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    variant_id: uuid.UUID,
    critic_passed: bool,
    platform: str,
    posting_mode: Optional[str] = None,
) -> None:
    """
    Called by content_pipeline after a variant is saved.

    Decision table:
      auto + critic_passed  → auto-enqueue (status → queued)
      auto + not passed     → leave as draft (needs human review)
      approval + any        → leave as-is (needs human approval)
      suggestion_only + any → force status to 'draft' even if critic passed
    """
    if posting_mode is None:
        posting_mode = await get_posting_mode(pool, org_id)

    if posting_mode == MODE_SUGGESTION_ONLY:
        # Override: suggestion_only always lands as draft
        await _force_to_draft(pool, variant_id)
        return

    if posting_mode == MODE_AUTO and critic_passed:
        # Auto-enqueue immediately
        variant = await _fetch_variant_for_queue(pool, org_id, variant_id)
        if not variant:
            log.error("handle_pipeline_completion_variant_missing",
                      variant_id=str(variant_id))
            return

        queue_id = await _enqueue_variant(
            pool=pool,
            org_id=org_id,
            variant_id=variant_id,
            platform=platform,
            actor_user_id=None,    # system action
            scheduled_for=None,    # immediate
        )
        await _mark_variant_queued(pool, variant_id, actor_user_id=None)
        await _log_event(
            pool=pool,
            variant_id=variant_id,
            org_id=org_id,
            event_type=EVT_AUTO_QUEUED,
            actor_user_id=None,
            mode_at_event=posting_mode,
            status_before="approved",
            status_after="queued",
            metadata={"queue_id": str(queue_id), "platform": platform},
        )
        log.info("auto_enqueued", variant_id=str(variant_id), platform=platform)

    # approval mode (or auto mode when critic failed) → no action needed


async def handle_human_approval(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    variant_id: uuid.UUID,
    actor_user_id: uuid.UUID,
    force_approve: bool = False,
    scheduled_publish_at: Optional[datetime] = None,
) -> dict:
    """
    Human approval action from POST /drafts/{id}/approve.

    Transitions:
      auto mode:            approve → approved + auto-enqueue → queued
      approval mode:        approve → approved + enqueue → queued
      suggestion_only mode: approve → approved (NO enqueue)

    force_approve=True means critic said 'revise' but human overrides.
    Sets critic_decision='force_approved' in addition to status='approved'.

    Returns the updated variant row as a dict.
    """
    posting_mode = await get_posting_mode(pool, org_id)
    event_type = EVT_FORCE_APPROVED if force_approve else EVT_HUMAN_APPROVED

    async with pool.acquire() as conn:
        now = datetime.now(timezone.utc)
        row = await conn.fetchrow(
            """
            WITH prior AS (
                SELECT status FROM growth.content_variants
                WHERE id = $5 AND org_id = $6
            )
            UPDATE growth.content_variants
            SET status         = 'approved',
                critic_decision = CASE
                    WHEN $1 THEN 'force_approved'
                    ELSE COALESCE(critic_decision, 'approve')
                END,
                approved_by    = $2,
                approved_at    = $3,
                finalized_at   = COALESCE(finalized_at, $3),
                scheduled_publish_at = COALESCE($4, scheduled_publish_at)
            WHERE id = $5
              AND org_id = $6
              AND status NOT IN ('published', 'queued', 'rejected')
            RETURNING id, org_id, idea_id, platform, status,
                      body_text, original_body_text,
                      angle_type, angle_title, core_claim,
                      hook_text, hook_rank,
                      prompt_version, generation_attempt,
                      critic_decision, critic_scores_json, revision_brief,
                      is_user_edited, finalized_at, created_at,
                      approved_by, approved_at, queued_at, scheduled_publish_at,
                      (SELECT status FROM prior) AS prior_status
            """,
            force_approve,
            actor_user_id,
            now,
            scheduled_publish_at,
            variant_id,
            org_id,
        )

    if not row:
        return {}   # caller raises 404 or 409

    variant_dict = dict(row)
    platform = variant_dict["platform"]
    prior_status = variant_dict.pop("prior_status", None)  # not part of the response model

    await _log_event(
        pool=pool,
        variant_id=variant_id,
        org_id=org_id,
        event_type=event_type,
        actor_user_id=actor_user_id,
        mode_at_event=posting_mode,
        status_before=prior_status,
        status_after="approved",
    )

    # suggestion_only: approve only, no enqueue
    if posting_mode == MODE_SUGGESTION_ONLY:
        log.info("human_approved_suggestion_only",
                 variant_id=str(variant_id), mode=posting_mode)
        return variant_dict

    # auto + approval: approve → immediately enqueue
    queue_id = await _enqueue_variant(
        pool=pool,
        org_id=org_id,
        variant_id=variant_id,
        platform=platform,
        actor_user_id=actor_user_id,
        scheduled_for=scheduled_publish_at,
    )
    await _mark_variant_queued(pool, variant_id, actor_user_id=actor_user_id)
    await _log_event(
        pool=pool,
        variant_id=variant_id,
        org_id=org_id,
        event_type=EVT_AUTO_QUEUED if posting_mode == MODE_AUTO else EVT_HUMAN_QUEUED,
        actor_user_id=actor_user_id,
        mode_at_event=posting_mode,
        status_before="approved",
        status_after="queued",
        metadata={"queue_id": str(queue_id), "platform": platform},
    )

    # Re-fetch to return queued status
    variant_dict["status"] = "queued"
    variant_dict["queued_at"] = datetime.now(timezone.utc)
    return variant_dict


async def handle_explicit_queue(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    variant_id: uuid.UUID,
    actor_user_id: uuid.UUID,
    scheduled_for: Optional[datetime] = None,
) -> dict:
    """
    Human explicitly queues an approved variant via POST /drafts/{id}/queue.
    Works in ALL modes — this is always a human-initiated override.

    Requires variant.status == 'approved'.
    Returns the queue item dict.
    """
    posting_mode = await get_posting_mode(pool, org_id)

    async with pool.acquire() as conn:
        variant = await conn.fetchrow(
            "SELECT id, platform, status FROM growth.content_variants WHERE id = $1 AND org_id = $2",
            variant_id, org_id,
        )

    if not variant:
        return {}
    if variant["status"] not in ("approved",):
        return {"error": f"cannot_queue_status:{variant['status']}"}

    queue_id = await _enqueue_variant(
        pool=pool,
        org_id=org_id,
        variant_id=variant_id,
        platform=variant["platform"],
        actor_user_id=actor_user_id,
        scheduled_for=scheduled_for,
    )
    await _mark_variant_queued(pool, variant_id, actor_user_id=actor_user_id)
    await _log_event(
        pool=pool,
        variant_id=variant_id,
        org_id=org_id,
        event_type=EVT_HUMAN_QUEUED,
        actor_user_id=actor_user_id,
        mode_at_event=posting_mode,
        status_before="approved",
        status_after="queued",
        metadata={"queue_id": str(queue_id), "platform": variant["platform"]},
    )

    return {"queue_id": queue_id, "variant_id": variant_id, "status": "queued"}


async def handle_edit(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    variant_id: uuid.UUID,
    new_body_text: str,
    actor_user_id: uuid.UUID,
) -> dict:
    """
    Human edits body_text via PATCH /drafts/{id}.

    Always:
      - updates body_text
      - sets is_user_edited = true
      - reverts status to 'draft' (invalidates any prior approval)
      - cancels any pending queue entries for this variant
      - logs ApprovalEvent(edited)

    Cannot edit published variants (they are immutable).
    Returns the updated variant row dict, or {} if not found/published.
    """
    posting_mode = await get_posting_mode(pool, org_id)

    # Capture current status before any mutations
    prior_status = await _get_variant_status(pool, variant_id, org_id)

    # Cancel any pending queue entries first (before status change)
    cancelled_count = await _cancel_pending_queue_entries(pool, variant_id)

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE growth.content_variants
            SET body_text      = $1,
                is_user_edited = true,
                status         = 'draft',
                approved_by    = NULL,
                approved_at    = NULL,
                queued_at      = NULL,
                finalized_at   = NULL
            WHERE id = $2
              AND org_id = $3
              AND status NOT IN ('published')
            RETURNING id, org_id, idea_id, platform, status,
                      body_text, original_body_text,
                      angle_type, angle_title, core_claim,
                      hook_text, hook_rank,
                      prompt_version, generation_attempt,
                      critic_decision, critic_scores_json, revision_brief,
                      is_user_edited, finalized_at, created_at,
                      approved_by, approved_at, queued_at, scheduled_publish_at
            """,
            new_body_text,
            variant_id,
            org_id,
        )

    if not row:
        return {}

    await _log_event(
        pool=pool,
        variant_id=variant_id,
        org_id=org_id,
        event_type=EVT_EDITED,
        actor_user_id=actor_user_id,
        mode_at_event=posting_mode,
        status_before=prior_status,
        status_after="draft",
        notes=f"body_text updated; {cancelled_count} queue entries cancelled",
    )

    if cancelled_count > 0:
        await _log_event(
            pool=pool,
            variant_id=variant_id,
            org_id=org_id,
            event_type=EVT_QUEUE_CANCELLED,
            actor_user_id=actor_user_id,
            mode_at_event=posting_mode,
            metadata={"cancelled_count": cancelled_count, "reason": "edited"},
        )

    return dict(row)


async def handle_rejection(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    variant_id: uuid.UUID,
    actor_user_id: uuid.UUID,
) -> bool:
    """
    Human rejects a variant via DELETE /drafts/{id}.
    Cancels any pending queue entries.
    Returns True if the variant was found and rejected.
    """
    posting_mode = await get_posting_mode(pool, org_id)
    prior_status = await _get_variant_status(pool, variant_id, org_id)
    await _cancel_pending_queue_entries(pool, variant_id)

    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE growth.content_variants
            SET status = 'rejected'
            WHERE id = $1 AND org_id = $2
              AND status NOT IN ('published', 'rejected')
            """,
            variant_id,
            org_id,
        )

    count = int(result.split()[-1]) if result else 0
    if count == 0:
        return False

    await _log_event(
        pool=pool,
        variant_id=variant_id,
        org_id=org_id,
        event_type=EVT_REJECTED,
        actor_user_id=actor_user_id,
        mode_at_event=posting_mode,
        status_before=prior_status,
        status_after="rejected",
    )
    return True


async def get_approval_history(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    variant_id: uuid.UUID,
    limit: int = 50,
) -> list[dict]:
    """
    Return approval events for a variant, newest first.
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, variant_id, org_id, event_type,
                   actor_user_id, mode_at_event,
                   variant_status_before, variant_status_after,
                   notes, metadata, created_at
            FROM growth.content_approval_events
            WHERE variant_id = $1 AND org_id = $2
            ORDER BY created_at DESC
            LIMIT $3
            """,
            variant_id,
            org_id,
            limit,
        )
    return [dict(r) for r in rows]


# ── Internal helpers ────────────────────────────────────────────────────────────

async def _enqueue_variant(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    variant_id: uuid.UUID,
    platform: str,
    actor_user_id: Optional[uuid.UUID],
    scheduled_for: Optional[datetime] = None,
) -> uuid.UUID:
    """
    Insert a publish_queue row. Returns the new queue item's id.
    Uses minute-precision idempotency key to absorb double-clicks.
    """
    now = datetime.now(timezone.utc)
    scheduled = scheduled_for or now
    prefix = f"manual:{actor_user_id}" if actor_user_id else "auto"
    # Minute-precision dedup: prevents double-click from creating two entries
    ikey = f"{prefix}:{variant_id}:{platform}:{now.isoformat()[:16]}"

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO growth.publish_queue (
                org_id, platform, variant_id,
                idempotency_key, status,
                attempt_count, max_attempts, scheduled_for
            ) VALUES ($1, $2, $3, $4, 'pending', 0, 5, $5)
            ON CONFLICT (idempotency_key) DO UPDATE
                SET updated_at = NOW()
            RETURNING id
            """,
            org_id,
            platform,
            variant_id,
            ikey,
            scheduled,
        )
    return row["id"]


async def _mark_variant_queued(
    pool: asyncpg.Pool,
    variant_id: uuid.UUID,
    actor_user_id: Optional[uuid.UUID],
) -> None:
    """Set variant.status = 'queued' and record queued_at."""
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE growth.content_variants
            SET status    = 'queued',
                queued_at = NOW()
            WHERE id = $1
              AND status IN ('approved', 'draft')
            """,
            variant_id,
        )


async def _force_to_draft(pool: asyncpg.Pool, variant_id: uuid.UUID) -> None:
    """Force variant to 'draft' status (used by suggestion_only mode)."""
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE growth.content_variants
            SET status = 'draft'
            WHERE id = $1 AND status IN ('approved', 'needs_review')
            """,
            variant_id,
        )


async def _cancel_pending_queue_entries(
    pool: asyncpg.Pool,
    variant_id: uuid.UUID,
) -> int:
    """
    Cancel all pending queue entries for a variant.
    Only cancels 'pending' items — locked/published items are not touched
    (worker is already processing them; let them complete or fail naturally).
    Returns count of cancelled entries.
    """
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE growth.publish_queue
            SET status     = 'cancelled',
                updated_at = NOW()
            WHERE variant_id = $1 AND status = 'pending'
            """,
            variant_id,
        )
    count = int(result.split()[-1]) if result else 0
    if count > 0:
        log.info("queue_entries_cancelled", variant_id=str(variant_id), count=count)
    return count


async def _fetch_variant_for_queue(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    variant_id: uuid.UUID,
) -> Optional[dict]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, platform, status FROM growth.content_variants WHERE id = $1 AND org_id = $2",
            variant_id, org_id,
        )
    return dict(row) if row else None


async def _get_variant_status(
    pool: asyncpg.Pool,
    variant_id: uuid.UUID,
    org_id: uuid.UUID,
) -> Optional[str]:
    """Fetch current variant status (for status_before capture)."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT status FROM growth.content_variants WHERE id = $1 AND org_id = $2",
            variant_id, org_id,
        )
    return row["status"] if row else None


async def _log_event(
    pool: asyncpg.Pool,
    variant_id: uuid.UUID,
    org_id: uuid.UUID,
    event_type: str,
    mode_at_event: str,
    actor_user_id: Optional[uuid.UUID] = None,
    status_before: Optional[str] = None,
    status_after: Optional[str] = None,
    notes: Optional[str] = None,
    metadata: Optional[dict] = None,
) -> None:
    """Append one approval event record. Never raises (errors are logged)."""
    try:
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO growth.content_approval_events (
                    variant_id, org_id, event_type,
                    actor_user_id, mode_at_event,
                    variant_status_before, variant_status_after,
                    notes, metadata
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
                """,
                variant_id,
                org_id,
                event_type,
                actor_user_id,
                mode_at_event,
                status_before,
                status_after,
                notes,
                json.dumps(metadata) if metadata else None,
            )
    except Exception as exc:
        log.error("approval_event_log_failed",
                  event_type=event_type, variant_id=str(variant_id), error=str(exc))
