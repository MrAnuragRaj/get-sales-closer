"""009 — Async Scoring Queue: decouple LLM scoring from the request path

Changes:

  growth.engagement_opportunities (ALTER):
    status CHECK extended with two new transient states:

      'pending_score' — opportunity ingested, awaiting LLM scoring by worker.
                        Set at INSERT time by the discovery handler.  No scores
                        or action text yet.

      'scoring'       — worker has claimed this row and is running the LLM call.
                        Transient: resolved to pending_review/auto_approved/failed
                        within the same worker tick.  Sweep cleans up stuck rows
                        after 5 minutes and resets to pending_score for retry.

    score_attempts INT NOT NULL DEFAULT 0
                        Incremented by the worker on every scoring attempt
                        (success or failure).  At score_attempts >= 3 the worker
                        transitions to 'failed' rather than retrying.

  Indices:
    idx_engagement_opps_pending_score — partial index for fast worker polling
    idx_engagement_opps_scoring       — partial index for sweep of stuck 'scoring'

Before this migration the full scoring flow was synchronous in the request
handler (discover → LLM → insert).  After this migration:

  Request handler:  ingest raw post → dedup → INSERT pending_score  (fast, <5ms)
  Scoring worker:   poll pending_score → LLM → UPDATE scored status  (async)
  Execution:        already LLM-free, unaffected

Revision ID: 009
Revises: 008
Create Date: 2026-03-12
"""

from __future__ import annotations

from alembic import op

revision: str = "009"
down_revision = "008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""

    -- ── Extend status CHECK ────────────────────────────────────────────────────

    ALTER TABLE growth.engagement_opportunities
        DROP CONSTRAINT IF EXISTS engagement_opportunities_status_check;

    ALTER TABLE growth.engagement_opportunities
        ADD CONSTRAINT engagement_opportunities_status_check
        CHECK (status IN (
            'pending_score', 'scoring',
            'pending_review', 'approved', 'auto_approved',
            'rejected', 'executing', 'executed', 'failed', 'expired'
        ));

    -- ── score_attempts counter ─────────────────────────────────────────────────

    ALTER TABLE growth.engagement_opportunities
        ADD COLUMN IF NOT EXISTS score_attempts INT NOT NULL DEFAULT 0;

    -- ── Indices ────────────────────────────────────────────────────────────────

    -- Worker polling: FIFO by discovery time, only pending rows
    CREATE INDEX IF NOT EXISTS idx_engagement_opps_pending_score
        ON growth.engagement_opportunities (discovered_at ASC)
        WHERE status = 'pending_score';

    -- Sweep: find stuck 'scoring' rows (process crashed mid-LLM)
    CREATE INDEX IF NOT EXISTS idx_engagement_opps_scoring
        ON growth.engagement_opportunities (updated_at)
        WHERE status = 'scoring';

    """)


def downgrade() -> None:
    op.execute("""

    DROP INDEX IF EXISTS growth.idx_engagement_opps_scoring;
    DROP INDEX IF EXISTS growth.idx_engagement_opps_pending_score;

    ALTER TABLE growth.engagement_opportunities
        DROP COLUMN IF EXISTS score_attempts;

    ALTER TABLE growth.engagement_opportunities
        DROP CONSTRAINT IF EXISTS engagement_opportunities_status_check;

    ALTER TABLE growth.engagement_opportunities
        ADD CONSTRAINT engagement_opportunities_status_check
        CHECK (status IN (
            'pending_review', 'approved', 'auto_approved',
            'rejected', 'executing', 'executed', 'failed', 'expired'
        ));

    """)
