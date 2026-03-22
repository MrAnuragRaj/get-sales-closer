"""
Drafts API — content variant management (Phase 5: mode-aware).

Routes:
  GET    /growth/drafts                       — list variants for the org
  GET    /growth/drafts/{id}                  — fetch a single variant
  POST   /growth/drafts/{id}/approve          — approve variant (mode-aware enqueue)
  POST   /growth/drafts/{id}/queue            — explicitly enqueue an approved variant
  PATCH  /growth/drafts/{id}                  — edit body_text (resets approval)
  DELETE /growth/drafts/{id}                  — reject variant
  GET    /growth/drafts/{id}/approval-history — full audit trail

Mode behavior (posting_mode in org_growth_settings):

  auto
    Pipeline: critic passed → status='approved' → auto-enqueued immediately
    POST /approve: approve → enqueue immediately
    PATCH: edit → status='draft', cancel pending queue, approval invalidated

  approval
    Pipeline: critic passed → status='approved' (NOT queued yet)
    POST /approve: approve → enqueue immediately
    PATCH: edit → status='draft', cancel pending queue

  suggestion_only
    Pipeline: always status='draft' regardless of critic result
    POST /approve: approve → status='approved' (NO enqueue)
    POST /queue:   explicit enqueue of an approved variant (all modes)
    PATCH: edit → status='draft'

Mode changes do NOT affect already-queued items — only future actions.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.auth_bridge import AuthContext, require_auth
from app.db import get_pool
from app.models.draft import (
    ApprovalEventOut,
    ContentVariantListResponse,
    ContentVariantOut,
    VariantEditRequest,
)
from app.services.approval_engine import (
    get_approval_history,
    handle_edit,
    handle_explicit_queue,
    handle_human_approval,
    handle_rejection,
)

router = APIRouter(prefix="/drafts", tags=["drafts"])

# Columns returned by all variant queries (keeps SELECT lists DRY)
_VARIANT_COLS = """
    id, org_id, idea_id, platform, status,
    body_text, original_body_text,
    angle_type, angle_title, core_claim,
    hook_text, hook_rank,
    prompt_version, generation_attempt,
    critic_decision, critic_scores_json, revision_brief,
    is_user_edited, finalized_at, created_at,
    approved_by, approved_at, queued_at, scheduled_publish_at
"""


# ── List ────────────────────────────────────────────────────────────────────────

@router.get("", response_model=ContentVariantListResponse)
async def list_variants(
    platform: Optional[str] = None,
    status: Optional[str] = None,
    idea_id: Optional[uuid.UUID] = None,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    where = "WHERE cv.org_id = $1"
    params: list = [auth.org_id]

    if platform:
        where += f" AND cv.platform = ${len(params)+1}"
        params.append(platform)
    if status:
        where += f" AND cv.status = ${len(params)+1}"
        params.append(status)
    if idea_id:
        where += f" AND cv.idea_id = ${len(params)+1}"
        params.append(idea_id)

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT {_VARIANT_COLS} FROM growth.content_variants cv "
            f"{where} ORDER BY cv.created_at DESC "
            f"LIMIT ${len(params)+1} OFFSET ${len(params)+2}",
            *params, limit, offset,
        )
        count_row = await conn.fetchrow(
            f"SELECT COUNT(*) FROM growth.content_variants cv {where}",
            *params,
        )

    variants = [ContentVariantOut.model_validate(dict(r)) for r in rows]
    return ContentVariantListResponse(variants=variants, total=count_row["count"])


# ── Get single ──────────────────────────────────────────────────────────────────

@router.get("/{variant_id}", response_model=ContentVariantOut)
async def get_variant(
    variant_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"SELECT {_VARIANT_COLS} FROM growth.content_variants "
            "WHERE id = $1 AND org_id = $2",
            variant_id, auth.org_id,
        )
    if not row:
        raise HTTPException(status_code=404, detail="Variant not found")
    return ContentVariantOut.model_validate(dict(row))


# ── Approve (mode-aware) ────────────────────────────────────────────────────────

@router.post("/{variant_id}/approve", response_model=ContentVariantOut)
async def approve_variant(
    variant_id: uuid.UUID,
    scheduled_publish_at: Optional[datetime] = None,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """
    Approve a variant. Behavior depends on posting_mode:

    auto:            approve → immediately enqueued → status='queued'
    approval:        approve → immediately enqueued → status='queued'
    suggestion_only: approve → status='approved' (no enqueue; call POST /queue separately)

    Works on variants in status: draft, needs_review.
    If variant was in 'draft' due to a failed critic, this is a force-approve.
    """
    async with pool.acquire() as conn:
        variant_row = await conn.fetchrow(
            "SELECT status, critic_decision FROM growth.content_variants WHERE id = $1 AND org_id = $2",
            variant_id, auth.org_id,
        )

    if not variant_row:
        raise HTTPException(404, "variant_not_found")

    current_status = variant_row["status"]
    if current_status not in ("draft", "needs_review", "approved"):
        raise HTTPException(
            409,
            f"cannot_approve: variant is in status={current_status}. "
            "Only draft/needs_review/approved variants can be approved."
        )

    # force_approve=True when human is approving a critic-failed draft
    force = current_status in ("draft", "needs_review") and variant_row["critic_decision"] != "approve"

    result = await handle_human_approval(
        pool=pool,
        org_id=auth.org_id,
        variant_id=variant_id,
        actor_user_id=auth.user_id,
        force_approve=force,
        scheduled_publish_at=scheduled_publish_at,
    )

    if not result:
        raise HTTPException(404, "variant_not_found_or_not_approvable")

    return ContentVariantOut.model_validate(result)


# ── Explicit queue (all modes — human override) ─────────────────────────────────

@router.post("/{variant_id}/queue", status_code=201)
async def queue_variant(
    variant_id: uuid.UUID,
    scheduled_for: Optional[datetime] = None,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """
    Explicitly enqueue an approved variant for publishing.
    Works in ALL posting modes — this is always a human-initiated override.

    Requires variant.status == 'approved'.
    Returns the created queue item reference.
    """
    result = await handle_explicit_queue(
        pool=pool,
        org_id=auth.org_id,
        variant_id=variant_id,
        actor_user_id=auth.user_id,
        scheduled_for=scheduled_for,
    )

    if not result:
        raise HTTPException(404, "variant_not_found")
    if "error" in result:
        raise HTTPException(422, result["error"])

    return result


# ── Edit (invalidates approval) ─────────────────────────────────────────────────

@router.patch("/{variant_id}", response_model=ContentVariantOut)
async def edit_variant(
    variant_id: uuid.UUID,
    body: VariantEditRequest,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """
    Edit a variant's body_text. Always:
      - sets is_user_edited = true
      - reverts status to 'draft' (approval invalidated in all modes)
      - cancels any pending publish_queue entries for this variant
      - logs an approval event

    Cannot edit published variants (immutable).
    """
    result = await handle_edit(
        pool=pool,
        org_id=auth.org_id,
        variant_id=variant_id,
        new_body_text=body.body_text,
        actor_user_id=auth.user_id,
    )

    if not result:
        raise HTTPException(
            404,
            "Variant not found or cannot be edited (published variants are immutable)"
        )
    return ContentVariantOut.model_validate(result)


# ── Reject ──────────────────────────────────────────────────────────────────────

@router.delete("/{variant_id}", status_code=status.HTTP_204_NO_CONTENT)
async def reject_variant(
    variant_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """
    Reject a variant. Cancels any pending queue entries.
    Rejected variants can be recovered via PATCH (edit reverts to draft).
    """
    found = await handle_rejection(
        pool=pool,
        org_id=auth.org_id,
        variant_id=variant_id,
        actor_user_id=auth.user_id,
    )
    if not found:
        raise HTTPException(404, "Variant not found or cannot be rejected")


# ── Approval history ────────────────────────────────────────────────────────────

@router.get("/{variant_id}/approval-history", response_model=list[ApprovalEventOut])
async def get_variant_approval_history(
    variant_id: uuid.UUID,
    limit: int = Query(50, ge=1, le=200),
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """
    Full audit trail for a variant — every approval, edit, queue, and rejection event.
    Includes mode_at_event so you can see what mode was active at each action.
    """
    # Verify variant belongs to org
    async with pool.acquire() as conn:
        exists = await conn.fetchrow(
            "SELECT id FROM growth.content_variants WHERE id = $1 AND org_id = $2",
            variant_id, auth.org_id,
        )
    if not exists:
        raise HTTPException(404, "variant_not_found")

    events = await get_approval_history(
        pool=pool,
        org_id=auth.org_id,
        variant_id=variant_id,
        limit=limit,
    )
    return [ApprovalEventOut.model_validate(e) for e in events]
