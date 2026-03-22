"""005 — Phase 6: Engagement Engine tables

Changes:

  engagement_targets:
    NEW TABLE — who/what to monitor for engagement opportunities.
    target_type: profile | company | hashtag | keyword
    One row per (org, platform, target_type, target_identifier).

  engagement_opportunities:
    NEW TABLE — discovered posts that can be acted on.
    opportunity_type: comment | reply   (likes/reposts excluded from v1)
    status: pending_review | approved | auto_approved | rejected | executed | failed | expired
    Scored by confidence (0-1) and risk (0-1) at discovery time.
    UNIQUE on (org_id, platform, post_platform_id, opportunity_type) — no duplicate opportunities.

  engagement_actions:
    NEW TABLE — append-only log of every executed engagement.
    Captures: opportunity context, confidence/risk scores, approval metadata,
    actor_user_id, platform_action_id — for Phase 7 analytics / ROI attribution.
    One row per attempt (success or failure).

  engagement_daily_caps:
    NEW TABLE — two-layer cap tracking:
      commercial cap:  scope='commercial', action_type='total'
                       enforced first; maps to plan limit (starter=5, pro=15)
      safety cap:      scope='safety', platform-specific per action_type
                       enforced second; prevents API anti-spam
    UNIQUE on (org_id, scope, platform, action_type, cap_date).

Commercial plan caps (locked pricing):
  engagement_starter ($99):  5 total billable engagements/day
  engagement_pro    ($199): 15 total billable engagements/day

Platform safety caps (informational, higher than commercial cap in all cases):
  LinkedIn: comment 15/day, reply 10/day
  X:        comment 8/day,  reply 6/day
  Facebook: comment 10/day
  Instagram: comment 8/day

Enforcement order:
  1. Commercial total cap  → blocked if org has used ≥ plan limit today
  2. Platform safety cap   → blocked if action would exceed platform anti-spam threshold
  3. Execute

Rationale:
  Engagement is separate from publishing — it reacts to other people's content.
  tables describe: targets (what to watch), opportunities (what we found),
  actions (what we did). Cap table separates commercial entitlement from
  platform-level safety so neither can silently expand the other.

Revision ID: 005
Revises: 004
Create Date: 2026-03-12
"""

from __future__ import annotations

from alembic import op

revision: str = "005"
down_revision = "004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""

    -- ── Engagement targets ────────────────────────────────────────────────────

    CREATE TABLE growth.engagement_targets (
        id                  UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        org_id              UUID        NOT NULL,
        platform            TEXT        NOT NULL
            CHECK (platform IN ('linkedin', 'x', 'instagram', 'facebook')),
        target_type         TEXT        NOT NULL
            CHECK (target_type IN ('profile', 'company', 'hashtag', 'keyword')),

        -- The handle/slug/tag/phrase to monitor
        target_identifier   TEXT        NOT NULL,

        -- Human-readable display name
        target_name         TEXT,

        -- Why this target matters to our org
        description         TEXT,

        is_active           BOOLEAN     NOT NULL DEFAULT true,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE (org_id, platform, target_type, target_identifier)
    );

    CREATE INDEX idx_engagement_targets_org_active
        ON growth.engagement_targets (org_id, is_active);

    CREATE INDEX idx_engagement_targets_platform
        ON growth.engagement_targets (org_id, platform)
        WHERE is_active = true;


    -- ── Engagement opportunities ──────────────────────────────────────────────

    CREATE TABLE growth.engagement_opportunities (
        id                      UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        org_id                  UUID        NOT NULL,
        target_id               UUID        NOT NULL
            REFERENCES growth.engagement_targets(id) ON DELETE CASCADE,
        platform                TEXT        NOT NULL,

        -- v1: comment | reply only. likes/reposts disabled.
        opportunity_type        TEXT        NOT NULL
            CHECK (opportunity_type IN ('comment', 'reply')),

        -- Source post metadata (from platform API)
        post_platform_id        TEXT        NOT NULL,
        post_url                TEXT,
        post_body_snippet       TEXT,                   -- first ~500 chars
        author_platform_id      TEXT,
        author_name             TEXT,

        -- Scoring (0.0 – 1.0)
        confidence_score        REAL        NOT NULL DEFAULT 0.0
            CHECK (confidence_score BETWEEN 0 AND 1),
        risk_score              REAL        NOT NULL DEFAULT 0.0
            CHECK (risk_score BETWEEN 0 AND 1),
        relevance_score         REAL        NOT NULL DEFAULT 0.0
            CHECK (relevance_score BETWEEN 0 AND 1),

        -- Status lifecycle
        status                  TEXT        NOT NULL DEFAULT 'pending_review'
            CHECK (status IN (
                'pending_review', 'approved', 'auto_approved',
                'rejected', 'executed', 'failed', 'expired'
            )),
        rejection_reason        TEXT,

        -- Generated engagement text
        generated_action_text   TEXT,
        generation_model        TEXT,

        -- Approval tracking
        approved_by             UUID,       -- NULL = auto-approved by system
        approved_at             TIMESTAMPTZ,

        -- Timing
        discovered_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        scheduled_for           TIMESTAMPTZ,
        executed_at             TIMESTAMPTZ,

        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE (org_id, platform, post_platform_id, opportunity_type)
    );

    CREATE INDEX idx_engagement_opps_org_status
        ON growth.engagement_opportunities (org_id, status, discovered_at DESC);

    CREATE INDEX idx_engagement_opps_target
        ON growth.engagement_opportunities (target_id, discovered_at DESC);

    CREATE INDEX idx_engagement_opps_scheduled
        ON growth.engagement_opportunities (org_id, scheduled_for ASC)
        WHERE status IN ('approved', 'auto_approved');


    -- ── Engagement actions ────────────────────────────────────────────────────
    -- Append-only. Every field needed for Phase 7 analytics/ROI is captured here.

    CREATE TABLE growth.engagement_actions (
        id                  UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        org_id              UUID        NOT NULL,
        opportunity_id      UUID        NOT NULL
            REFERENCES growth.engagement_opportunities(id) ON DELETE CASCADE,
        platform            TEXT        NOT NULL,
        action_type         TEXT        NOT NULL,       -- comment | reply
        action_text         TEXT,                       -- text sent to platform
        platform_action_id  TEXT,                       -- ID returned by platform API

        -- Scores at time of execution (denormalized for analytics — no join needed)
        confidence_score    REAL,
        risk_score          REAL,

        -- Approval context (for analytics: "did auto-approved do better than human-approved?")
        approval_status     TEXT
            CHECK (approval_status IN ('auto_approved', 'human_approved')),
        actor_user_id       UUID,                       -- NULL = auto-executed by system

        -- Execution result
        status              TEXT        NOT NULL
            CHECK (status IN ('success', 'failed')),
        http_status         INT,
        error_message       TEXT,

        executed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_engagement_actions_org_executed
        ON growth.engagement_actions (org_id, executed_at DESC);

    CREATE INDEX idx_engagement_actions_opportunity
        ON growth.engagement_actions (opportunity_id);


    -- ── Daily engagement caps ─────────────────────────────────────────────────
    -- Two scopes:
    --   'commercial' / action_type='total': the plan-level billable total
    --   'safety'     / action_type=specific: per-platform anti-spam protection

    CREATE TABLE growth.engagement_daily_caps (
        id              UUID    NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        org_id          UUID    NOT NULL,
        scope           TEXT    NOT NULL CHECK (scope IN ('commercial', 'safety')),
        platform        TEXT    NOT NULL DEFAULT 'all',  -- 'all' for commercial scope
        action_type     TEXT    NOT NULL,                -- 'total' for commercial scope
        cap_date        DATE    NOT NULL DEFAULT CURRENT_DATE,
        count           INT     NOT NULL DEFAULT 0 CHECK (count >= 0),

        UNIQUE (org_id, scope, platform, action_type, cap_date)
    );

    CREATE INDEX idx_engagement_caps_org_date
        ON growth.engagement_daily_caps (org_id, cap_date);

    """)


def downgrade() -> None:
    op.execute("""
    DROP TABLE IF EXISTS growth.engagement_daily_caps;
    DROP TABLE IF EXISTS growth.engagement_actions;
    DROP TABLE IF EXISTS growth.engagement_opportunities;
    DROP TABLE IF EXISTS growth.engagement_targets;
    """)
