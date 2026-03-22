"""004 — Phase 5: publish fingerprint + approval audit table

Changes:

  publish_queue:
    ADD COLUMN external_publish_fingerprint TEXT
      — set by queue_worker after a successful publish (same as published_platform_id
        but indexed for reconciliation / duplicate-detection queries)
    ADD UNIQUE INDEX idx_publish_queue_fingerprint
      (partial — NULL rows excluded; fingerprints must be unique per org+platform)
    ADD INDEX idx_publish_queue_published_platform_id
      (for reporting: "find all LinkedIn posts for this org")

  content_variants:
    ADD COLUMN approved_by  UUID   — auth.users.id of the human who approved
    ADD COLUMN approved_at  TIMESTAMPTZ
    ADD COLUMN queued_at    TIMESTAMPTZ  — when variant entered 'queued' status
    ADD COLUMN scheduled_publish_at TIMESTAMPTZ  — requested publish time (nullable)
    ADD INDEX  idx_content_variants_approved_by  — audit queries

  content_approval_events:
    NEW TABLE — append-only event log for every approval-related state transition.
    event_type values:
      auto_queued        — pipeline auto-enqueued (auto mode)
      human_approved     — human approved a draft (approval / suggestion_only modes)
      force_approved     — human force-approved a needs_review variant
      human_queued       — human explicitly called POST /queue
      rejected           — human rejected (DELETE /drafts/{id})
      edited             — human edited body_text; prior approval invalidated
      queue_cancelled    — pending queue entry cancelled (by edit or explicit cancel)
      mode_snapshot      — informational: records mode active at time of event

    actor_user_id is NULL for system-triggered events (auto mode pipeline).
    mode_at_event captures posting_mode at time of event (immutable record).

Rationale:
  With a publish_queue that reconciles against external platform IDs,
  we need aggressive indexing on published_platform_id and a dedicated
  fingerprint column that is always populated on successful publish.

  The content_approval_events table enables:
    - Full audit trail for compliance ("who approved this post?")
    - Mode-change investigation ("what mode was active when this was queued?")
    - Analytics ("how long does approval take in approval mode vs auto mode?")

Revision ID: 004
Revises: 003
Create Date: 2026-03-12
"""

from __future__ import annotations

from alembic import op

revision: str = "004"
down_revision = "003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""

    -- ── publish_queue enhancements ────────────────────────────────────────────

    ALTER TABLE growth.publish_queue
        ADD COLUMN external_publish_fingerprint TEXT;

    -- Unique fingerprint for reconciliation (NULL excluded — unfilled before publish)
    CREATE UNIQUE INDEX idx_publish_queue_fingerprint
        ON growth.publish_queue (external_publish_fingerprint)
        WHERE external_publish_fingerprint IS NOT NULL;

    -- Index for reporting: "all published posts on LinkedIn for this org"
    CREATE INDEX idx_publish_queue_published_platform_id
        ON growth.publish_queue (org_id, platform, published_platform_id)
        WHERE published_platform_id IS NOT NULL;

    -- ── content_variants approval tracking ───────────────────────────────────

    ALTER TABLE growth.content_variants
        ADD COLUMN approved_by          UUID,
        ADD COLUMN approved_at          TIMESTAMPTZ,
        ADD COLUMN queued_at            TIMESTAMPTZ,
        ADD COLUMN scheduled_publish_at TIMESTAMPTZ;

    CREATE INDEX idx_content_variants_approved_by
        ON growth.content_variants (approved_by)
        WHERE approved_by IS NOT NULL;

    -- ── Approval event log ────────────────────────────────────────────────────

    CREATE TABLE growth.content_approval_events (
        id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        variant_id      UUID        NOT NULL
            REFERENCES growth.content_variants(id) ON DELETE CASCADE,
        org_id          UUID        NOT NULL,

        -- What happened
        event_type      TEXT        NOT NULL
            CHECK (event_type IN (
                'auto_queued', 'human_approved', 'force_approved',
                'human_queued', 'rejected', 'edited',
                'queue_cancelled', 'mode_snapshot'
            )),

        -- Who did it (NULL = system / pipeline)
        actor_user_id   UUID,

        -- Mode at the time of the event — immutable record
        mode_at_event   TEXT        NOT NULL
            CHECK (mode_at_event IN ('auto', 'approval', 'suggestion_only')),

        -- Status transition audit — what was the variant status before and after this event
        -- NULL for events where status doesn't change (e.g. mode_snapshot)
        variant_status_before  TEXT,
        variant_status_after   TEXT,

        -- Freeform context (e.g. edit diff summary, cancellation reason)
        notes           TEXT,

        -- Structured metadata (queue_id, scheduled_for, etc.)
        metadata        JSONB,

        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Lookup by variant (all events for one post)
    CREATE INDEX idx_approval_events_variant
        ON growth.content_approval_events (variant_id, created_at DESC);

    -- Lookup by org + time (audit feed)
    CREATE INDEX idx_approval_events_org_created
        ON growth.content_approval_events (org_id, created_at DESC);

    -- Lookup by actor (who approved the most?)
    CREATE INDEX idx_approval_events_actor
        ON growth.content_approval_events (actor_user_id)
        WHERE actor_user_id IS NOT NULL;

    """)


def downgrade() -> None:
    op.execute("""
    DROP TABLE IF EXISTS growth.content_approval_events;

    DROP INDEX IF EXISTS growth.idx_content_variants_approved_by;
    ALTER TABLE growth.content_variants
        DROP COLUMN IF EXISTS approved_by,
        DROP COLUMN IF EXISTS approved_at,
        DROP COLUMN IF EXISTS queued_at,
        DROP COLUMN IF EXISTS scheduled_publish_at;

    DROP INDEX IF EXISTS growth.idx_publish_queue_fingerprint;
    DROP INDEX IF EXISTS growth.idx_publish_queue_published_platform_id;
    ALTER TABLE growth.publish_queue
        DROP COLUMN IF EXISTS external_publish_fingerprint;
    """)
