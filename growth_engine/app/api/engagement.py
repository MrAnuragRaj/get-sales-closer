"""
Engagement Engine API — Phase 6.

Routes:
  GET    /growth/engagement/targets                      — list engagement targets
  POST   /growth/engagement/targets                      — create target
  GET    /growth/engagement/targets/{id}                 — get target
  PATCH  /growth/engagement/targets/{id}                 — update target
  DELETE /growth/engagement/targets/{id}                 — delete target
  POST   /growth/engagement/targets/{id}/discover        — submit posts for discovery

  GET    /growth/engagement/opportunities                — list opportunities
  GET    /growth/engagement/opportunities/{id}           — get opportunity
  POST   /growth/engagement/opportunities/{id}/approve   — human approve
  DELETE /growth/engagement/opportunities/{id}           — reject
  POST   /growth/engagement/opportunities/{id}/execute   — execute now

  GET    /growth/engagement/actions                      — list executed actions
  GET    /growth/engagement/caps                         — daily cap status

Access control:
  - All routes require valid JWT (require_auth).
  - engagement_starter or engagement_pro service must be active for /discover
    and /execute. Other CRUD routes work without a plan (so operators can
    set up targets before the plan is active).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.auth_bridge import AuthContext, require_auth
from app.db import get_pool
from app.models.engagement import (
    ActionListResponse,
    DailyCapsResponse,
    DiscoverRequest,
    EngagementOpportunityOut,
    EngagementTargetCreate,
    EngagementTargetListResponse,
    EngagementTargetOut,
    EngagementTargetUpdate,
    OpportunityApproveRequest,
    OpportunityListResponse,
)
from app.services.engagement import discovery, executor, targets
from app.services.engagement.planner import (
    get_caps_status,
    get_org_plan,
)
from app.services.rate_limiter import check_rate_limit

router = APIRouter(prefix="/engagement", tags=["engagement"])

_OPP_COLS = """
    o.id, o.org_id, o.target_id, o.platform, o.opportunity_type,
    o.post_platform_id, o.post_url, o.post_body_snippet,
    o.author_platform_id, o.author_name,
    o.confidence_score, o.risk_score, o.relevance_score,
    o.status, o.rejection_reason,
    o.generated_action_text, o.generation_model,
    o.approved_by, o.approved_at,
    o.discovered_at, o.scheduled_for, o.executed_at,
    o.created_at, o.updated_at,
    o.influencer_node_id,
    n.seen_count      AS author_seen_count,
    n.engaged_count   AS author_engaged_count,
    n.last_engaged_at AS author_last_engaged_at
"""

# Simple cols for single-row fetches that don't need graph context
_OPP_COLS_SIMPLE = """
    id, org_id, target_id, platform, opportunity_type,
    post_platform_id, post_url, post_body_snippet,
    author_platform_id, author_name,
    confidence_score, risk_score, relevance_score,
    status, rejection_reason,
    generated_action_text, generation_model,
    approved_by, approved_at,
    discovered_at, scheduled_for, executed_at,
    created_at, updated_at,
    influencer_node_id
"""

_ACTION_COLS = """
    id, org_id, opportunity_id, platform, action_type,
    action_text, platform_action_id,
    confidence_score, risk_score,
    approval_status, actor_user_id,
    status, http_status, error_message, error_category,
    executed_at, created_at
"""


# ── Targets ──────────────────────────────────────────────────────────────────

@router.get("/targets", response_model=EngagementTargetListResponse)
async def list_engagement_targets(
    platform: Optional[str] = Query(None),
    active_only: bool = Query(True),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    rows, total = await targets.list_targets(
        pool, auth.org_id, platform=platform, active_only=active_only,
        limit=limit, offset=offset,
    )
    return {"targets": rows, "total": total}


@router.post("/targets", response_model=EngagementTargetOut, status_code=status.HTTP_201_CREATED)
async def create_engagement_target(
    body: EngagementTargetCreate,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    row = await targets.create_target(pool, auth.org_id, body)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="target_already_exists",
        )
    return row


@router.get("/targets/{target_id}", response_model=EngagementTargetOut)
async def get_engagement_target(
    target_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    row = await targets.get_target(pool, auth.org_id, target_id)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="target_not_found")
    return row


@router.patch("/targets/{target_id}", response_model=EngagementTargetOut)
async def update_engagement_target(
    target_id: uuid.UUID,
    body: EngagementTargetUpdate,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    row = await targets.update_target(pool, auth.org_id, target_id, body)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="target_not_found")
    return row


@router.delete("/targets/{target_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_engagement_target(
    target_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    deleted = await targets.delete_target(pool, auth.org_id, target_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="target_not_found")


@router.post("/targets/{target_id}/discover")
async def trigger_discovery(
    target_id: uuid.UUID,
    body: DiscoverRequest,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """
    Submit a batch of pre-fetched posts for opportunity discovery.

    In production, this is called by a platform webhook or a scheduled crawler.
    For manual testing, POST your discovered posts directly here.

    Returns a summary of how many opportunities were created vs duplicated.
    """
    plan = await get_org_plan(pool, auth.org_id)
    if plan == "none":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="no_engagement_plan_active",
        )

    allowed, _, _ = await check_rate_limit(pool, auth.org_id, "engage:discover", 10, "hour")
    if not allowed:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail="rate_limit_exceeded:engage:discover:10/hr")

    target = await targets.get_target(pool, auth.org_id, target_id)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="target_not_found")
    if not target["is_active"]:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="target_is_inactive")

    created = await discovery.process_post_batch(
        pool, auth.org_id, target, body.posts,
    )

    return {
        "submitted": len(body.posts),
        "created": len(created),
        "duplicates_skipped": len(body.posts) - len(created),
        "opportunities": created,
    }


# ── Opportunities ─────────────────────────────────────────────────────────────

@router.get("/opportunities", response_model=OpportunityListResponse)
async def list_opportunities(
    status_filter: Optional[str] = Query(None, alias="status"),
    platform: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    conditions = ["o.org_id = $1"]
    params: list = [auth.org_id]
    i = 2

    if status_filter:
        conditions.append(f"o.status = ${i}")
        params.append(status_filter)
        i += 1
    if platform:
        conditions.append(f"o.platform = ${i}")
        params.append(platform)
        i += 1

    where = " AND ".join(conditions)

    async with pool.acquire() as conn:
        total = await conn.fetchval(
            f"SELECT COUNT(*) FROM growth.engagement_opportunities o WHERE {where}",
            *params,
        )
        rows = await conn.fetch(
            f"""
            SELECT {_OPP_COLS}
            FROM growth.engagement_opportunities o
            LEFT JOIN growth.influencer_nodes n ON n.id = o.influencer_node_id
            WHERE {where}
            ORDER BY o.discovered_at DESC
            LIMIT ${i} OFFSET ${i+1}
            """,
            *params, limit, offset,
        )
    return {"opportunities": [dict(r) for r in rows], "total": total}


@router.get("/opportunities/{opp_id}", response_model=EngagementOpportunityOut)
async def get_opportunity(
    opp_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"SELECT {_OPP_COLS} FROM growth.engagement_opportunities WHERE id = $1 AND org_id = $2",
            opp_id, auth.org_id,
        )
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="opportunity_not_found")
    return dict(row)


@router.post("/opportunities/{opp_id}/approve", response_model=EngagementOpportunityOut)
async def approve_opportunity(
    opp_id: uuid.UUID,
    body: OpportunityApproveRequest,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """
    Human approves a pending_review opportunity.
    Sets status → 'approved' and records actor + timestamp.
    """
    now = datetime.utcnow()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"""
            UPDATE growth.engagement_opportunities
            SET status       = 'approved',
                approved_by  = $1,
                approved_at  = $2,
                scheduled_for = COALESCE($3, scheduled_for),
                updated_at   = NOW()
            WHERE id = $4 AND org_id = $5
              AND status = 'pending_review'
            RETURNING {_OPP_COLS}
            """,
            auth.user_id,
            now,
            body.scheduled_for,
            opp_id,
            auth.org_id,
        )

    if not row:
        # Check why
        async with pool.acquire() as conn:
            existing = await conn.fetchrow(
                "SELECT status FROM growth.engagement_opportunities WHERE id = $1 AND org_id = $2",
                opp_id, auth.org_id,
            )
        if not existing:
            raise HTTPException(status_code=404, detail="opportunity_not_found")
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"cannot_approve_status:{existing['status']}",
        )

    return dict(row)


@router.delete("/opportunities/{opp_id}", status_code=status.HTTP_204_NO_CONTENT)
async def reject_opportunity(
    opp_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """Reject an opportunity — sets status to 'rejected' (not hard deleted)."""
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE growth.engagement_opportunities
            SET status = 'rejected', updated_at = NOW()
            WHERE id = $1 AND org_id = $2
              AND status NOT IN ('executed', 'rejected')
            """,
            opp_id, auth.org_id,
        )
    count = int(result.split()[-1]) if result else 0
    if count == 0:
        async with pool.acquire() as conn:
            existing = await conn.fetchval(
                "SELECT 1 FROM growth.engagement_opportunities WHERE id = $1 AND org_id = $2",
                opp_id, auth.org_id,
            )
        if not existing:
            raise HTTPException(status_code=404, detail="opportunity_not_found")
        raise HTTPException(status_code=409, detail="opportunity_already_executed_or_rejected")


@router.post("/opportunities/{opp_id}/execute")
async def execute_opportunity_now(
    opp_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """
    Execute an approved or auto_approved opportunity immediately.
    Checks daily caps before executing.
    """
    plan = await get_org_plan(pool, auth.org_id)
    if plan == "none":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="no_engagement_plan_active",
        )

    allowed, _, _ = await check_rate_limit(pool, auth.org_id, "engage:execute", 30, "hour")
    if not allowed:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                            detail="rate_limit_exceeded:engage:execute:30/hr")

    result = await executor.execute_opportunity(pool, auth.org_id, opp_id, actor_user_id=auth.user_id)
    if not result["success"]:
        error = result.get("error", "unknown")
        if "not_found" in error:
            raise HTTPException(status_code=404, detail=error)
        if "cannot_execute_status" in error or "already_executing" in error:
            raise HTTPException(status_code=409, detail=error)
        if "cap_exceeded" in error or "no_engagement_plan" in error:
            raise HTTPException(status_code=429, detail=error)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=error)

    return result


# ── Decision Attribution ──────────────────────────────────────────────────────

@router.get("/opportunities/{opp_id}/decision")
async def get_opportunity_decision(
    opp_id: uuid.UUID,
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """
    Return decision attributions for a specific opportunity.

    Returns all attribution records (engagement_scored, engagement_executed)
    for this opportunity in chronological order.

    404 if the opportunity does not exist for this org.
    200 with empty 'decisions' array if no attribution has been written yet
    (e.g. scoring is still pending).
    """
    # Verify opportunity exists and belongs to this org
    async with pool.acquire() as conn:
        exists = await conn.fetchval(
            "SELECT 1 FROM growth.engagement_opportunities WHERE id = $1 AND org_id = $2",
            opp_id, auth.org_id,
        )
    if not exists:
        raise HTTPException(status_code=404, detail="opportunity_not_found")

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT decision_type, policy, outcome, decision_reason,
                   feature_vector, model_version, decided_at
            FROM growth.decision_attributions
            WHERE org_id     = $1
              AND subject_id  = $2
              AND subject_type = 'opportunity'
            ORDER BY decided_at ASC
            """,
            auth.org_id, opp_id,
        )

    return {
        "opportunity_id": str(opp_id),
        "decisions": [dict(r) for r in rows],
    }


# ── Revenue Attribution ───────────────────────────────────────────────────────

@router.get("/attributions")
async def list_revenue_attributions(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """
    List revenue attributions — engagements matched to CRM leads.

    Returns attributions joined with lead name and last action text,
    ordered by most recently attributed first.

    Run POST /internal/run-attribution-sweep to generate new attributions.
    Returns 200 with empty list if no attributions exist yet.
    """
    async with pool.acquire() as conn:
        total = await conn.fetchval(
            "SELECT COUNT(*) FROM growth.revenue_attributions WHERE org_id = $1",
            auth.org_id,
        )
        rows = await conn.fetch(
            """
            SELECT
                ra.id,
                ra.lead_id,
                l.name                  AS lead_name,
                ra.influencer_node_id,
                n.author_name,
                n.seen_count,
                n.engaged_count,
                ra.platform,
                ra.matched_on,
                ra.match_value,
                ra.attribution_score,
                ra.attributed_at,
                ea.action_text          AS last_action_text,
                ea.executed_at          AS last_action_at
            FROM growth.revenue_attributions ra
            LEFT JOIN public.leads l
                ON l.id = ra.lead_id
            LEFT JOIN growth.influencer_nodes n
                ON n.id = ra.influencer_node_id
            LEFT JOIN growth.engagement_actions ea
                ON ea.id = ra.action_id
            WHERE ra.org_id = $1
            ORDER BY ra.attributed_at DESC
            LIMIT $2 OFFSET $3
            """,
            auth.org_id, limit, offset,
        )

    return {
        "attributions": [dict(r) for r in rows],
        "total": total,
    }


# ── Actions log ───────────────────────────────────────────────────────────────

@router.get("/actions", response_model=ActionListResponse)
async def list_actions(
    platform: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    conditions = ["org_id = $1"]
    params: list = [auth.org_id]
    i = 2

    if platform:
        conditions.append(f"platform = ${i}")
        params.append(platform)
        i += 1

    where = " AND ".join(conditions)

    async with pool.acquire() as conn:
        total = await conn.fetchval(
            f"SELECT COUNT(*) FROM growth.engagement_actions WHERE {where}",
            *params,
        )
        rows = await conn.fetch(
            f"""
            SELECT {_ACTION_COLS}
            FROM growth.engagement_actions
            WHERE {where}
            ORDER BY executed_at DESC
            LIMIT ${i} OFFSET ${i+1}
            """,
            *params, limit, offset,
        )
    return {"actions": [dict(r) for r in rows], "total": total}


# ── Daily cap status ──────────────────────────────────────────────────────────

@router.get("/caps", response_model=DailyCapsResponse)
async def get_daily_caps(
    auth: AuthContext = Depends(require_auth),
    pool: asyncpg.Pool = Depends(get_pool),
):
    """Return current daily engagement cap usage for the org (commercial + platform safety)."""
    from datetime import date
    plan = await get_org_plan(pool, auth.org_id)
    caps_data = await get_caps_status(pool, auth.org_id, plan)
    return {
        "plan": plan,
        "date": date.today().isoformat(),
        **caps_data,
    }
