"""006 — Phase 7: Platform Metrics Normalization + Growth Intelligence Layer

Changes:

  platform_metric_snapshots:
    NEW TABLE — raw metric dumps from platform APIs (append-only).
    Stores whatever the platform returns, keyed by (variant_id, platform, snapshot_date).
    Serves as the immutable source of truth before normalization.

  content_metrics:
    NEW TABLE — normalized metrics per variant per snapshot_date.
    All platforms mapped to a common schema: impressions, reach, clicks,
    reactions, comments_received, shares, video_views, engagement_rate.
    Calculated fields: engagement_rate = (reactions + comments + shares) / impressions.

  engagement_roi_events:
    NEW TABLE — links engagement actions (Phase 6) to measurable outcomes.
    Captures the metric delta between engagement execution and a follow-up
    snapshot (e.g. did commenting on a post drive profile views?).

  growth_intelligence_summaries:
    NEW TABLE — org-level weekly/monthly intelligence rollups.
    One row per (org_id, period_type, period_start).
    Stores structured JSON: top performers, platform trends, engagement ROI,
    posting frequency analysis, actionable recommendations.

Rationale:
  Metrics normalization decouples the ingestion format (platform-specific)
  from the analytics format (standard schema). content_metrics is the query
  layer; platform_metric_snapshots is the audit layer.

  growth_intelligence_summaries enables the "Growth Intelligence" dashboard —
  weekly auto-generated insights without O(N) queries at read time.

Revision ID: 006
Revises: 005
Create Date: 2026-03-12
"""

from __future__ import annotations

from alembic import op

revision: str = "006"
down_revision = "005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""

    -- ── Raw platform metric snapshots ─────────────────────────────────────────
    -- Append-only — never updated. Source of truth for re-normalization.

    CREATE TABLE growth.platform_metric_snapshots (
        id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        org_id          UUID        NOT NULL,
        variant_id      UUID        NOT NULL
            REFERENCES growth.content_variants(id) ON DELETE CASCADE,
        platform        TEXT        NOT NULL,
        snapshot_date   DATE        NOT NULL,

        -- The raw JSON payload from the platform API
        raw_metrics     JSONB       NOT NULL,

        -- Where these metrics came from (e.g. 'linkedin_analytics_v2', 'manual_import')
        source          TEXT        NOT NULL DEFAULT 'api',

        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE (variant_id, platform, snapshot_date, source)
    );

    CREATE INDEX idx_metric_snapshots_variant_date
        ON growth.platform_metric_snapshots (variant_id, snapshot_date DESC);

    CREATE INDEX idx_metric_snapshots_org_date
        ON growth.platform_metric_snapshots (org_id, snapshot_date DESC);


    -- ── Normalized content metrics ─────────────────────────────────────────────
    -- One row per (variant, platform, snapshot_date). Updated on re-ingest.

    CREATE TABLE growth.content_metrics (
        id                  UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        org_id              UUID        NOT NULL,
        variant_id          UUID        NOT NULL
            REFERENCES growth.content_variants(id) ON DELETE CASCADE,
        platform            TEXT        NOT NULL,
        snapshot_date       DATE        NOT NULL,

        -- Platform-native post ID — from publish_queue.published_platform_id.
        -- Preserved here so analytics can survive variant re-queuing or platform
        -- ID changes without losing the metric → post linkage.
        platform_post_id    TEXT,

        -- Core reach metrics
        impressions         INT         NOT NULL DEFAULT 0,
        reach               INT         NOT NULL DEFAULT 0,

        -- Engagement metrics (platform-normalized)
        clicks              INT         NOT NULL DEFAULT 0,
        reactions           INT         NOT NULL DEFAULT 0,  -- likes/hearts/etc.
        comments_received   INT         NOT NULL DEFAULT 0,  -- comments on our post
        shares              INT         NOT NULL DEFAULT 0,
        video_views         INT         NOT NULL DEFAULT 0,  -- 0 if not video

        -- Calculated
        -- engagement_rate = (reactions + comments_received + shares) / NULLIF(impressions, 0)
        engagement_rate     REAL        NOT NULL DEFAULT 0.0,

        -- Snapshot lineage
        snapshot_id         UUID        REFERENCES growth.platform_metric_snapshots(id),

        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE (variant_id, platform, snapshot_date)
    );

    CREATE INDEX idx_content_metrics_variant
        ON growth.content_metrics (variant_id, snapshot_date DESC);

    CREATE INDEX idx_content_metrics_org_platform_date
        ON growth.content_metrics (org_id, platform, snapshot_date DESC);

    -- For finding top performers
    CREATE INDEX idx_content_metrics_engagement_rate
        ON growth.content_metrics (org_id, platform, engagement_rate DESC)
        WHERE impressions > 0;


    -- ── Engagement ROI events ──────────────────────────────────────────────────
    -- Links Phase 6 engagement actions to measurable metric outcomes.
    -- Created when a follow-up metric snapshot shows change after an engagement.

    CREATE TABLE growth.engagement_roi_events (
        id                      UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        org_id                  UUID        NOT NULL,

        -- The engagement action that may have driven this outcome
        action_id               UUID        NOT NULL
            REFERENCES growth.engagement_actions(id) ON DELETE CASCADE,

        -- The target post/profile that was engaged with
        target_platform_id      TEXT        NOT NULL,   -- the post we commented on
        platform                TEXT        NOT NULL,

        -- Metric deltas measured after the engagement
        -- (null = not measured / not applicable for this platform)
        profile_views_delta     INT,        -- did our profile views change?
        follower_delta          INT,        -- did we gain followers?
        connection_requests     INT,        -- LinkedIn connection requests received
        post_clicks_delta       INT,        -- clicks on our content after engagement

        -- Measurement window
        measured_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        measurement_window_hours INT        NOT NULL DEFAULT 24,

        -- Attribution confidence (0-1): how confident are we this delta was caused by this action?
        attribution_confidence  REAL        NOT NULL DEFAULT 0.0
            CHECK (attribution_confidence BETWEEN 0 AND 1),

        notes                   TEXT,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_engagement_roi_action
        ON growth.engagement_roi_events (action_id);

    CREATE INDEX idx_engagement_roi_org_date
        ON growth.engagement_roi_events (org_id, measured_at DESC);


    -- ── Growth intelligence summaries ─────────────────────────────────────────
    -- Pre-computed org-level intelligence. One row per (org, period_type, period_start).
    -- Updated by a cron/background job, not at query time.

    CREATE TABLE growth.growth_intelligence_summaries (
        id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        org_id          UUID        NOT NULL,

        -- Period: 'weekly' or 'monthly'
        period_type     TEXT        NOT NULL CHECK (period_type IN ('weekly', 'monthly')),
        period_start    DATE        NOT NULL,    -- Monday for weekly, 1st for monthly
        period_end      DATE        NOT NULL,

        -- Summary payload — structured JSON with standard keys:
        --   top_performing_variants: [{variant_id, platform, engagement_rate, impressions}]
        --   platform_trends:         [{platform, avg_engagement_rate, total_impressions, delta_vs_prior}]
        --   posting_frequency:       [{platform, posts_published, recommended_frequency}]
        --   engagement_roi:          {total_actions, avg_confidence, avg_risk, top_outcomes}
        --   recommendations:         [{priority, category, action, reason}]
        --   health_score:            float 0-100
        summary_json    JSONB       NOT NULL DEFAULT '{}',

        -- Generation metadata
        generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        generation_model TEXT,                               -- e.g. 'gpt-4o-mini'
        variants_analyzed INT       NOT NULL DEFAULT 0,

        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE (org_id, period_type, period_start)
    );

    CREATE INDEX idx_intelligence_org_period
        ON growth.growth_intelligence_summaries (org_id, period_type, period_start DESC);

    """)


def downgrade() -> None:
    op.execute("""
    DROP TABLE IF EXISTS growth.growth_intelligence_summaries;
    DROP TABLE IF EXISTS growth.engagement_roi_events;
    DROP TABLE IF EXISTS growth.content_metrics;
    DROP TABLE IF EXISTS growth.platform_metric_snapshots;
    """)
