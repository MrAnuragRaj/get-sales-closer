"""
Stale state recovery sweeps.

Called by POST /internal/sweep (cron-triggered, internal secret auth).
Each sweep is idempotent — safe to run multiple times.

Sweeps:
  1. stuck_generating
     content_variants stuck in status='generating' for > GENERATING_TTL_MINUTES.
     Root cause: LLM call failed or worker crashed after status was set but before
     it could be updated. Without a sweep, these variants are invisible forever.
     Recovery: set status='failed', log count.

  2. expired_opportunities
     engagement_opportunities in status='pending_review' or 'auto_approved'
     for > OPPORTUNITY_TTL_DAYS.
     Root cause: human never reviewed, worker never executed, or content stale.
     Recovery: set status='expired'.

  3. orphaned_queue
     publish_queue items in status='scheduled' or 'locked' where scheduled_for
     is more than QUEUE_ORPHAN_MINUTES in the past AND locked_until is expired or null.
     Root cause: publish worker crashed mid-lock or was never triggered.
     Recovery: set status='failed', last_error='sweep_orphaned'.
     NOTE: marks failed only — does NOT re-attempt. Re-queuing is a manual op.

  4. stuck_executing
     engagement_opportunities stuck in status='executing' for > EXECUTING_TTL_MINUTES.
     Root cause: process crashed after the atomic claim but before the platform API
     call completed (or returned).  Without a sweep, these rows are permanently locked
     in 'executing' and the opportunity is invisible forever.
     Recovery: set status='failed', rejection_reason='execution_timeout'.
     The original opportunity is terminal — new discovery will re-find the post
     if the target is still active.

All counts returned in SweepResult for logging and alerting.
"""

from __future__ import annotations

from dataclasses import dataclass

import asyncpg

from app.logging_config import get_logger

log = get_logger(__name__)

# ── TTL constants ─────────────────────────────────────────────────────────────

GENERATING_TTL_MINUTES = 5       # variant stuck 'generating' for this long → failed
SCORING_TTL_MINUTES    = 5       # opportunity stuck 'scoring' for this long → reset to pending_score
EXECUTING_TTL_MINUTES  = 5       # opportunity stuck 'executing' for this long → failed
OPPORTUNITY_TTL_DAYS   = 7       # opportunity in pending/auto_approved → expired
QUEUE_ORPHAN_MINUTES   = 30      # scheduled queue item past due + lock expired → failed


@dataclass
class SweepResult:
    stuck_generating_recovered: int = 0
    stuck_scoring_reset:        int = 0
    stuck_executing_recovered:  int = 0
    opportunities_expired:      int = 0
    queue_orphans_failed:       int = 0

    def total(self) -> int:
        return (
            self.stuck_generating_recovered
            + self.stuck_scoring_reset
            + self.stuck_executing_recovered
            + self.opportunities_expired
            + self.queue_orphans_failed
        )


async def run_all_sweeps(pool: asyncpg.Pool) -> SweepResult:
    """
    Run all four sweeps. Returns aggregate counts.
    Each sweep is independent — failure in one does not skip the others.
    """
    result = SweepResult()

    try:
        result.stuck_generating_recovered = await sweep_stuck_generating(pool)
    except Exception as exc:
        log.error("sweep_stuck_generating_failed", error=str(exc))

    try:
        result.stuck_scoring_reset = await sweep_stuck_scoring(pool)
    except Exception as exc:
        log.error("sweep_stuck_scoring_failed", error=str(exc))

    try:
        result.stuck_executing_recovered = await sweep_stuck_executing(pool)
    except Exception as exc:
        log.error("sweep_stuck_executing_failed", error=str(exc))

    try:
        result.opportunities_expired = await sweep_expired_opportunities(pool)
    except Exception as exc:
        log.error("sweep_expired_opportunities_failed", error=str(exc))

    try:
        result.queue_orphans_failed = await sweep_orphaned_queue(pool)
    except Exception as exc:
        log.error("sweep_orphaned_queue_failed", error=str(exc))

    log.info(
        "sweep_complete",
        stuck_generating=result.stuck_generating_recovered,
        stuck_scoring=result.stuck_scoring_reset,
        stuck_executing=result.stuck_executing_recovered,
        opportunities_expired=result.opportunities_expired,
        queue_orphans=result.queue_orphans_failed,
        total=result.total(),
    )
    return result


async def sweep_stuck_generating(pool: asyncpg.Pool) -> int:
    """
    Recover content_variants stuck in status='generating'.

    A variant is stuck if:
      - status = 'generating'
      - updated_at < NOW() - GENERATING_TTL_MINUTES

    Recovery: set status = 'failed'.
    The variant's topic/idea remains intact; the user can re-trigger generation.
    """
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE growth.content_variants
            SET status     = 'failed',
                updated_at = NOW()
            WHERE status     = 'generating'
              AND updated_at < NOW() - ($1 || ' minutes')::interval
            """,
            str(GENERATING_TTL_MINUTES),
        )
    # asyncpg returns "UPDATE N" string
    count = _parse_rowcount(result)
    if count:
        log.warning("sweep_stuck_generating_recovered", count=count,
                    ttl_minutes=GENERATING_TTL_MINUTES)
    return count


async def sweep_stuck_scoring(pool: asyncpg.Pool) -> int:
    """
    Reset engagement_opportunities stuck in status='scoring'.

    A row is stuck if:
      - status = 'scoring'
      - updated_at < NOW() - SCORING_TTL_MINUTES

    Root cause: the scoring worker process crashed or was killed after claiming
    the row (status→scoring) but before the LLM call completed.

    Recovery:
      - If score_attempts < MAX_SCORE_ATTEMPTS (3): reset to 'pending_score'
        so the next worker tick will re-attempt.
      - If score_attempts >= 3: set to 'failed' — exhausted retries.

    The two-statement approach avoids a CASE expression that would obscure intent.
    Both UPDATE statements are safe to run regardless of actual row counts.
    """
    from app.services.engagement.scoring_worker import MAX_SCORE_ATTEMPTS

    async with pool.acquire() as conn:
        # Reset retryable stuck rows
        result_retry = await conn.execute(
            """
            UPDATE growth.engagement_opportunities
            SET status     = 'pending_score',
                updated_at = NOW()
            WHERE status         = 'scoring'
              AND score_attempts  < $1
              AND updated_at     < NOW() - ($2 || ' minutes')::interval
            """,
            MAX_SCORE_ATTEMPTS,
            str(SCORING_TTL_MINUTES),
        )
        # Fail exhausted stuck rows
        result_fail = await conn.execute(
            """
            UPDATE growth.engagement_opportunities
            SET status           = 'failed',
                rejection_reason = 'scoring_timeout_max_retries',
                updated_at       = NOW()
            WHERE status         = 'scoring'
              AND score_attempts >= $1
              AND updated_at     < NOW() - ($2 || ' minutes')::interval
            """,
            MAX_SCORE_ATTEMPTS,
            str(SCORING_TTL_MINUTES),
        )

    count = _parse_rowcount(result_retry) + _parse_rowcount(result_fail)
    if count:
        log.warning("sweep_stuck_scoring_reset", count=count,
                    ttl_minutes=SCORING_TTL_MINUTES)
    return count


async def sweep_stuck_executing(pool: asyncpg.Pool) -> int:
    """
    Recover engagement_opportunities stuck in status='executing'.

    An opportunity is stuck if:
      - status = 'executing'
      - updated_at < NOW() - EXECUTING_TTL_MINUTES

    This happens when a process crashes after the atomic claim (status→executing)
    but before the platform API call completes and updates the status.
    Without this sweep, the row stays locked in 'executing' indefinitely.

    Recovery: set status = 'failed', rejection_reason = 'execution_timeout'.
    The opportunity is terminal — new discovery will re-find the post if active.
    """
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE growth.engagement_opportunities
            SET status           = 'failed',
                rejection_reason = 'execution_timeout',
                updated_at       = NOW()
            WHERE status     = 'executing'
              AND updated_at < NOW() - ($1 || ' minutes')::interval
            """,
            str(EXECUTING_TTL_MINUTES),
        )
    count = _parse_rowcount(result)
    if count:
        log.warning("sweep_stuck_executing_recovered", count=count,
                    ttl_minutes=EXECUTING_TTL_MINUTES)
    return count


async def sweep_expired_opportunities(pool: asyncpg.Pool) -> int:
    """
    Expire stale engagement opportunities.

    An opportunity is stale if:
      - status IN ('pending_review', 'auto_approved')
      - discovered_at < NOW() - OPPORTUNITY_TTL_DAYS

    Recovery: set status = 'expired'.
    Expired opportunities are terminal — they do not re-enter the pipeline.
    New opportunities for the same post will be re-discovered on the next
    discovery run (if the target is still active).
    """
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE growth.engagement_opportunities
            SET status     = 'expired',
                updated_at = NOW()
            WHERE status      IN ('pending_score', 'pending_review', 'auto_approved')
              AND discovered_at < NOW() - ($1 || ' days')::interval
            """,
            str(OPPORTUNITY_TTL_DAYS),
        )
    count = _parse_rowcount(result)
    if count:
        log.warning("sweep_opportunities_expired", count=count,
                    ttl_days=OPPORTUNITY_TTL_DAYS)
    return count


async def sweep_orphaned_queue(pool: asyncpg.Pool) -> int:
    """
    Fail orphaned publish queue items.

    An item is orphaned if:
      - status IN ('scheduled', 'locked')
      - scheduled_for < NOW() - QUEUE_ORPHAN_MINUTES
      - locked_until IS NULL OR locked_until < NOW()  (not actively held by a worker)

    Recovery: set status = 'failed', last_error = 'sweep_orphaned'.
    Marks items as failed only — callers must manually re-queue if needed.

    The locked_until guard ensures we don't fail items actively being processed
    by a worker that is merely slow.
    """
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE growth.publish_queue
            SET status     = 'failed',
                last_error = 'sweep_orphaned',
                updated_at = NOW()
            WHERE status       IN ('scheduled', 'locked')
              AND scheduled_for < NOW() - ($1 || ' minutes')::interval
              AND (locked_until IS NULL OR locked_until < NOW())
            """,
            str(QUEUE_ORPHAN_MINUTES),
        )
    count = _parse_rowcount(result)
    if count:
        log.warning("sweep_queue_orphans_failed", count=count,
                    ttl_minutes=QUEUE_ORPHAN_MINUTES)
    return count


def _parse_rowcount(pg_status: str) -> int:
    """Parse asyncpg 'UPDATE N' / 'DELETE N' status string → int."""
    try:
        return int(pg_status.split()[-1])
    except (ValueError, IndexError):
        return 0
