"""
Async scoring worker.

Polls engagement_opportunities rows in status='pending_score', claims them
atomically using FOR UPDATE SKIP LOCKED, calls the LLM scorer, and updates
each row to its final pre-execution status.

Status transitions:
  pending_score  →  scoring         (worker claims row)
  scoring        →  pending_review  (scored, not auto-safe)
  scoring        →  auto_approved   (scored, auto-safe for plan)
  scoring        →  pending_score   (LLM failed, attempts < MAX_SCORE_ATTEMPTS)
  scoring        →  failed          (LLM failed, attempts >= MAX_SCORE_ATTEMPTS)

Concurrency safety:
  FOR UPDATE SKIP LOCKED ensures that if multiple worker instances run
  simultaneously (e.g. burst cron calls), each row is processed by exactly
  one instance.  No application-level locking needed.

Retry behaviour:
  On LLM failure, score_attempts is incremented and the row returns to
  'pending_score'.  The next worker tick will re-attempt.
  After MAX_SCORE_ATTEMPTS (3), the row is set to 'failed' and leaves
  the scoring queue permanently.

Called by:
  POST /internal/run-scoring-worker  (cron-triggered, secret-gated)

Batch size:
  Controlled by settings.scoring_worker_batch_size (default 10).
  One cron tick processes one batch.  If the queue depth is high,
  the cron frequency should be increased or batch size raised.
"""

from __future__ import annotations

import uuid

import asyncpg

from app.config import settings
from app.logging_config import get_logger
from app.services.engagement.planner import get_org_plan, is_auto_safe
from app.services.engagement.scorer import score_opportunity
from app.services.feature_flags import get_flag

log = get_logger(__name__)

MAX_SCORE_ATTEMPTS = 3


async def run_scoring_worker(
    pool: asyncpg.Pool,
    batch_size: int = 10,
) -> int:
    """
    Process one batch of pending_score opportunities.

    Returns the number of rows claimed in this run (includes both
    successfully scored and failed rows).
    """
    rows = await _claim_batch(pool, batch_size)
    if not rows:
        log.debug("scoring_worker_idle", batch_size=batch_size)
        return 0

    log.info("scoring_worker_claimed", count=len(rows))

    for row in rows:
        await _score_one(pool, dict(row))

    return len(rows)


# ── Internal helpers ──────────────────────────────────────────────────────────

async def _claim_batch(
    pool: asyncpg.Pool,
    batch_size: int,
) -> list:
    """
    Atomically claim up to batch_size pending_score rows.

    Uses FOR UPDATE SKIP LOCKED so concurrent worker invocations each
    claim a non-overlapping set of rows.  Only rows with score_attempts
    below the max retry ceiling are eligible.

    Ordering:
      When GROWTH_GRAPH_PRIORITY_ENABLED=true (feature flag):
        1. Authors we've previously engaged with (engaged_count > 0) first
        2. Then by relationship strength (engaged_count * 5 + seen_count) DESC
        3. Finally FIFO by discovered_at ASC

      When flag is false (default):
        Pure FIFO — discovered_at ASC
        Safe fallback; flip the flag off at any time to revert instantly.
    """
    graph_priority = await get_flag(pool, "growth_graph_priority")
    if graph_priority:
        order_clause = """
            ORDER BY
                (CASE WHEN n.engaged_count > 0 THEN 0 ELSE 1 END) ASC,
                (COALESCE(n.engaged_count, 0) * 5 + COALESCE(n.seen_count, 0)) DESC,
                o.discovered_at ASC
        """
        inner_query = f"""
            SELECT o.id
            FROM growth.engagement_opportunities o
            LEFT JOIN growth.influencer_nodes n ON n.id = o.influencer_node_id
            WHERE o.status         = 'pending_score'
              AND o.score_attempts < $1
            {order_clause}
            LIMIT $2
            FOR UPDATE OF o SKIP LOCKED
        """
    else:
        inner_query = """
            SELECT id
            FROM growth.engagement_opportunities
            WHERE status         = 'pending_score'
              AND score_attempts < $1
            ORDER BY discovered_at ASC
            LIMIT $2
            FOR UPDATE SKIP LOCKED
        """

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            UPDATE growth.engagement_opportunities
            SET status     = 'scoring',
                updated_at = NOW()
            WHERE id IN (
                {inner_query}
            )
            RETURNING
                id, org_id, target_id, platform, opportunity_type,
                post_body_snippet, score_attempts
            """,
            MAX_SCORE_ATTEMPTS,
            batch_size,
        )
    return rows


async def _score_one(pool: asyncpg.Pool, row: dict) -> None:
    """
    Score one opportunity and persist the result.

    On LLM success: transitions to pending_review or auto_approved.
    On LLM failure: increments score_attempts; returns to pending_score
                    unless max retries reached (→ failed).
    """
    opp_id   = row["id"]
    org_id   = row["org_id"]
    platform = row["platform"]

    # Fetch the parent target for scoring context
    target = await _fetch_target(pool, row["target_id"])

    try:
        scoring = await score_opportunity(
            pool=pool,
            org_id=org_id,
            post_body=row["post_body_snippet"] or "",
            opportunity_type=row["opportunity_type"],
            target_identifier=target["target_identifier"] if target else "",
            target_type=target["target_type"] if target else "keyword",
            platform=platform,
        )

        plan = await get_org_plan(pool, org_id)

        # ── Auto-approval decision ────────────────────────────────────────────
        # When LEARNING_LOOP_ENABLED, use per-org learned thresholds instead of
        # plan defaults. Plan validity ('none' → never auto) still gates first.
        # When flag is off, fall back to is_auto_safe() (plan-hardcoded thresholds).
        learning_enabled = await get_flag(pool, "learning_loop")
        if learning_enabled and plan != "none":
            from app.services.learning_loop import (
                DEFAULT_CONF_THRESHOLD, DEFAULT_RISK_THRESHOLD, get_thresholds,
            )
            eff_conf_threshold, eff_risk_threshold = await get_thresholds(
                pool, org_id, platform,
            )
            auto_safe  = (
                scoring.confidence_score >= eff_conf_threshold
                and scoring.risk_score   <= eff_risk_threshold
            )
            new_status = "auto_approved" if auto_safe else "pending_review"
        else:
            from app.services.learning_loop import (
                DEFAULT_CONF_THRESHOLD, DEFAULT_RISK_THRESHOLD,
            )
            eff_conf_threshold = DEFAULT_CONF_THRESHOLD
            eff_risk_threshold = DEFAULT_RISK_THRESHOLD
            new_status = (
                "auto_approved"
                if is_auto_safe(scoring.confidence_score, scoring.risk_score, plan)
                else "pending_review"
            )

        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE growth.engagement_opportunities
                SET status                = $1,
                    confidence_score      = $2,
                    risk_score            = $3,
                    relevance_score       = $4,
                    generated_action_text = $5,
                    generation_model      = $6,
                    score_attempts        = score_attempts + 1,
                    updated_at            = NOW()
                WHERE id = $7 AND status = 'scoring'
                """,
                new_status,
                scoring.confidence_score,
                scoring.risk_score,
                scoring.relevance_score,
                scoring.generated_action_text,
                scoring.generation_model,
                opp_id,
            )

        log.info(
            "opportunity_scored",
            opp_id=str(opp_id), org_id=str(org_id), platform=platform,
            status=new_status,
            confidence=scoring.confidence_score, risk=scoring.risk_score,
        )

        from app.services.decision_logger import log_engagement_scored
        await log_engagement_scored(
            pool=pool,
            opp_id=opp_id,
            org_id=org_id,
            platform=platform,
            opportunity_type=row["opportunity_type"],
            confidence_score=scoring.confidence_score,
            risk_score=scoring.risk_score,
            relevance_score=scoring.relevance_score,
            new_status=new_status,
            model_version=scoring.generation_model,
            score_attempt=row["score_attempts"] + 1,
            plan=plan,
            auto_conf_threshold=eff_conf_threshold,
            auto_risk_threshold=eff_risk_threshold,
            learning_enabled=learning_enabled,
        )

    except Exception as exc:
        attempts_after = row["score_attempts"] + 1
        exhausted      = attempts_after >= MAX_SCORE_ATTEMPTS

        if exhausted:
            new_status = "failed"
            rejection  = "scoring_failed_max_retries"
        else:
            new_status = "pending_score"
            rejection  = None

        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE growth.engagement_opportunities
                SET status           = $1,
                    rejection_reason = $2,
                    score_attempts   = score_attempts + 1,
                    updated_at       = NOW()
                WHERE id = $3 AND status = 'scoring'
                """,
                new_status,
                rejection,
                opp_id,
            )

        log.warning(
            "opportunity_scoring_failed",
            opp_id=str(opp_id), org_id=str(org_id), platform=platform,
            attempts_after=attempts_after, exhausted=exhausted,
            error=str(exc),
        )


async def _fetch_target(pool: asyncpg.Pool, target_id: uuid.UUID) -> dict | None:
    """Fetch engagement target row for scoring context."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, target_type, target_identifier, platform
            FROM growth.engagement_targets
            WHERE id = $1
            """,
            target_id,
        )
    return dict(row) if row else None
