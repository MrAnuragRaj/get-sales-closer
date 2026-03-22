"""
Engagement opportunity executor.

execute_opportunity() handles the full execution flow:
  1. Fetch opportunity (with org_id guard)
  2. Verify status is executable (approved or auto_approved)
  3. Layer 1 cap check: commercial total (5/day starter, 15/day pro)
  4. Layer 2 cap check: platform safety cap
  5. Verify platform engagement capability (token, scopes, feature flags)
  6. Dispatch action to platform adapter
  7. Log action (append-only — all analytics fields captured)
  8. Update opportunity status
  9. Increment both cap counters on success

v1 supported action types: comment, reply
like and repost are not supported (excluded from plan semantics).

Platform routing:
  linkedin  → services/engagement/linkedin_executor.py
  facebook  → services/engagement/meta_executor.py
  instagram → services/engagement/meta_executor.py  (always PLATFORM_DISABLED)
  x         → services/engagement/x_executor.py     (always PLATFORM_DISABLED in v1)
"""

from __future__ import annotations

import uuid

import asyncpg

from app.logging_config import get_logger
from app.services.engagement.capability import get_engage_capable
from app.services.engagement.planner import (
    check_caps_available,
    get_org_plan,
    increment_caps,
)

log = get_logger(__name__)

_OPP_COLS = """
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


async def execute_opportunity(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    opportunity_id: uuid.UUID,
    actor_user_id: uuid.UUID | None = None,
) -> dict:
    """
    Execute one engagement opportunity.

    actor_user_id: set when a human triggers execution via the API.
    None = system/worker-triggered execution.

    Returns result dict: {success, error, platform_action_id}.
    Never raises — all errors are caught and logged.
    """
    opp = await _fetch_opportunity(pool, org_id, opportunity_id)
    if not opp:
        return {"success": False, "error": "opportunity_not_found"}

    if opp["status"] not in ("approved", "auto_approved"):
        return {"success": False, "error": f"cannot_execute_status:{opp['status']}"}

    # ── Atomic execution claim ────────────────────────────────────────────────
    # Transition status → 'executing' only if still approved/auto_approved.
    # Concurrent requests hitting the same opportunity will get no row returned
    # and short-circuit with a 409-equivalent error.  This prevents duplicate
    # platform posts regardless of double-clicks, retries, or worker races.
    claimed = await _claim_opportunity(pool, org_id, opportunity_id)
    if not claimed:
        log.warning("engagement_already_executing",
                    opportunity_id=str(opportunity_id), org_id=str(org_id))
        return {"success": False, "error": "already_executing_or_executed"}

    platform    = opp["platform"]
    action_type = opp["opportunity_type"]

    # Determine approval context for the action log
    if opp["status"] == "auto_approved":
        approval_status = "auto_approved"
    else:
        approval_status = "human_approved"

    # ── Two-layer cap check ───────────────────────────────────────────────────
    plan = await get_org_plan(pool, org_id)
    allowed, reason = await check_caps_available(pool, org_id, platform, action_type, plan)
    if not allowed:
        log.warning("engagement_cap_blocked",
                    org_id=str(org_id), platform=platform,
                    action_type=action_type, reason=reason)
        await _fail_opportunity(pool, opportunity_id, reason)
        return {"success": False, "error": reason}

    # ── Platform capability check ─────────────────────────────────────────────
    can_engage, cap_reason = await get_engage_capable(pool, org_id, platform)
    if not can_engage:
        log.warning("engagement_capability_blocked",
                    org_id=str(org_id), platform=platform, reason=cap_reason)
        await _fail_opportunity(pool, opportunity_id, cap_reason)
        return {"success": False, "error": cap_reason, "error_category": "CAPABILITY_MISSING"}

    # ── Execute ───────────────────────────────────────────────────────────────
    result = await _dispatch_action(pool, org_id, opp)

    # ── Decision attribution ──────────────────────────────────────────────────
    from app.services.decision_logger import log_engagement_executed
    await log_engagement_executed(
        pool=pool,
        opp_id=opportunity_id,
        org_id=org_id,
        platform=platform,
        approval_status=approval_status,
        confidence_score=opp.get("confidence_score"),
        risk_score=opp.get("risk_score"),
        cap_used=None,   # not tracked inline; available via /caps endpoint
        cap_limit=None,
        success=result["success"],
        http_status=result.get("http_status"),
        error_category=result.get("error_category"),
        platform_action_id=result.get("platform_action_id"),
    )

    # ── Log action (all analytics fields) ────────────────────────────────────
    await _write_action_log(
        pool=pool,
        org_id=org_id,
        opportunity_id=opportunity_id,
        platform=platform,
        action_type=action_type,
        action_text=opp.get("generated_action_text"),
        confidence_score=opp.get("confidence_score"),
        risk_score=opp.get("risk_score"),
        approval_status=approval_status,
        actor_user_id=actor_user_id,
        success=result["success"],
        http_status=result.get("http_status"),
        error_message=result.get("error"),
        error_category=result.get("error_category"),
        platform_action_id=result.get("platform_action_id"),
    )

    # ── Update opportunity + increment caps ───────────────────────────────────
    if result["success"]:
        await _mark_executed(pool, opportunity_id)
        await increment_caps(pool, org_id, platform, action_type)
        # Growth Graph: record successful engagement against the author node
        node_id = opp.get("influencer_node_id")
        if node_id:
            from app.services.growth_graph import record_engagement
            await record_engagement(pool, org_id, node_id)
        log.info("engagement_executed",
                 opportunity_id=str(opportunity_id), platform=platform,
                 action_type=action_type, approval_status=approval_status)
    else:
        await _fail_opportunity(pool, opportunity_id, result.get("error", "unknown"))
        log.warning("engagement_execution_failed",
                    opportunity_id=str(opportunity_id), error=result.get("error"))

    return result


async def _dispatch_action(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    opp: dict,
) -> dict:
    """
    Route to the appropriate platform adapter.
    Returns: {success, error, error_category, platform_action_id, http_status}.
    """
    action_type = opp["opportunity_type"]
    platform    = opp["platform"]

    if action_type not in ("comment", "reply"):
        # Should not reach here — opportunity_type CHECK constraint blocks other values
        return {"success": False, "error": f"unsupported_action_type:{action_type}"}

    post_platform_id = opp["post_platform_id"]
    action_text      = opp.get("generated_action_text") or ""

    result = await _call_platform_adapter(
        pool=pool,
        org_id=org_id,
        platform=platform,
        post_platform_id=post_platform_id,
        action_text=action_text,
        action_type=action_type,
    )
    return result


async def _call_platform_adapter(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    platform: str,
    post_platform_id: str,
    action_text: str,
    action_type: str,
) -> dict:
    """
    Dispatch to the correct platform executor and normalise the EngagementResult
    into a plain dict that executor.py works with.

    Platform routing:
      linkedin  → linkedin_executor.execute_linkedin_engagement
      facebook  → meta_executor.execute_meta_engagement
      instagram → meta_executor.execute_meta_engagement  (always PLATFORM_DISABLED)
      x         → x_executor.execute_x_engagement        (always PLATFORM_DISABLED in v1)
    """
    if platform == "linkedin":
        from app.services.engagement.linkedin_executor import execute_linkedin_engagement
        eng_result = await execute_linkedin_engagement(
            pool, org_id, platform, post_platform_id, action_text, action_type,
        )
    elif platform in ("facebook", "instagram"):
        from app.services.engagement.meta_executor import execute_meta_engagement
        eng_result = await execute_meta_engagement(
            pool, org_id, platform, post_platform_id, action_text, action_type,
        )
    elif platform == "x":
        from app.services.engagement.x_executor import execute_x_engagement
        eng_result = await execute_x_engagement(
            pool, org_id, platform, post_platform_id, action_text, action_type,
        )
    else:
        return {
            "success": False,
            "error": f"unknown_platform:{platform}",
            "error_category": "PERMANENT",
        }

    return {
        "success":            eng_result.success,
        "platform_action_id": eng_result.platform_action_id,
        "http_status":        eng_result.http_status,
        "error":              eng_result.error_message,
        "error_category":     eng_result.error_category,
    }


# ── DB helpers ───────────────────────────────────────────────────────────────

async def _claim_opportunity(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    opportunity_id: uuid.UUID,
) -> bool:
    """
    Atomically transition status → 'executing'.

    Returns True if this caller claimed the row (and may proceed).
    Returns False if another process already claimed it (concurrent request,
    double-click, worker retry) — the caller must abort without executing.

    Only matches rows still in 'approved' or 'auto_approved' so a row that
    was already executed or failed is also correctly rejected.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE growth.engagement_opportunities
            SET status = 'executing', updated_at = NOW()
            WHERE id = $1
              AND org_id = $2
              AND status IN ('approved', 'auto_approved')
            RETURNING id
            """,
            opportunity_id, org_id,
        )
    return row is not None


async def _fetch_opportunity(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    opportunity_id: uuid.UUID,
) -> dict | None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            f"SELECT {_OPP_COLS} FROM growth.engagement_opportunities WHERE id = $1 AND org_id = $2",
            opportunity_id, org_id,
        )
    return dict(row) if row else None


async def _mark_executed(pool: asyncpg.Pool, opportunity_id: uuid.UUID) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE growth.engagement_opportunities
            SET status = 'executed', executed_at = NOW(), updated_at = NOW()
            WHERE id = $1 AND status = 'executing'
            """,
            opportunity_id,
        )


async def _fail_opportunity(
    pool: asyncpg.Pool,
    opportunity_id: uuid.UUID,
    reason: str,
) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE growth.engagement_opportunities
            SET status = 'failed', rejection_reason = $2, updated_at = NOW()
            WHERE id = $1 AND status IN ('executing', 'approved', 'auto_approved')
            """,
            opportunity_id, reason,
        )


async def _write_action_log(
    pool: asyncpg.Pool,
    org_id: uuid.UUID,
    opportunity_id: uuid.UUID,
    platform: str,
    action_type: str,
    action_text: str | None,
    confidence_score: float | None,
    risk_score: float | None,
    approval_status: str,
    actor_user_id: uuid.UUID | None,
    success: bool,
    http_status: int | None,
    error_message: str | None,
    error_category: str | None,
    platform_action_id: str | None,
) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO growth.engagement_actions (
                org_id, opportunity_id, platform, action_type,
                action_text, platform_action_id,
                confidence_score, risk_score,
                approval_status, actor_user_id,
                status, http_status, error_message, error_category
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            """,
            org_id, opportunity_id, platform, action_type,
            action_text, platform_action_id,
            confidence_score, risk_score,
            approval_status, actor_user_id,
            "success" if success else "failed",
            http_status, error_message, error_category,
        )
