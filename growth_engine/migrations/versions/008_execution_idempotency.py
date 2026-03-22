"""008 — Execution idempotency: 'executing' status on engagement_opportunities

Changes:

  growth.engagement_opportunities (ALTER):
    status CHECK constraint extended to include 'executing'.

    'executing' is a transient lock state set atomically before any platform
    API call.  Only one concurrent request can transition an opportunity to
    'executing' — the UPDATE … WHERE status IN ('approved','auto_approved')
    RETURNING id pattern ensures exactly-once execution.

    If execution succeeds  → status transitions to 'executed'.
    If execution fails     → status transitions to 'failed'.
    If the process crashes → the stale-state sweeper resets 'executing' rows
    that are older than 5 minutes back to 'failed'.

Revision ID: 008
Revises: 007
Create Date: 2026-03-12
"""

from __future__ import annotations

from alembic import op

revision: str = "008"
down_revision = "007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""

    -- ── Extend status CHECK to include 'executing' ────────────────────────────
    -- Postgres auto-names the constraint as <table>_<column>_check.
    -- Drop the old constraint and recreate with the new value set.

    ALTER TABLE growth.engagement_opportunities
        DROP CONSTRAINT IF EXISTS engagement_opportunities_status_check;

    ALTER TABLE growth.engagement_opportunities
        ADD CONSTRAINT engagement_opportunities_status_check
        CHECK (status IN (
            'pending_review', 'approved', 'auto_approved',
            'rejected', 'executing', 'executed', 'failed', 'expired'
        ));

    -- Index for sweeper: quickly find stuck 'executing' rows older than N minutes
    CREATE INDEX IF NOT EXISTS idx_engagement_opps_executing
        ON growth.engagement_opportunities (org_id, updated_at)
        WHERE status = 'executing';

    """)


def downgrade() -> None:
    op.execute("""

    DROP INDEX IF EXISTS growth.idx_engagement_opps_executing;

    ALTER TABLE growth.engagement_opportunities
        DROP CONSTRAINT IF EXISTS engagement_opportunities_status_check;

    ALTER TABLE growth.engagement_opportunities
        ADD CONSTRAINT engagement_opportunities_status_check
        CHECK (status IN (
            'pending_review', 'approved', 'auto_approved',
            'rejected', 'executed', 'failed', 'expired'
        ));

    """)
