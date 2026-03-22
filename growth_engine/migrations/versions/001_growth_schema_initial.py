"""growth schema — initial migration

Creates the full growth schema with all 15 tables and indexes.
This is the complete Phase 1 schema. No data migration needed.

Tables created (all under growth.*):
  01. brand_profiles          — brand identity per org
  02. social_accounts         — connected platform OAuth credentials (encrypted)
  03. org_growth_settings     — operational mode + plan config per org
  04. content_ideas           — topic planner output
  05. content_variants        — platform-specific content derived from an idea
  06. content_assets          — rendered images/media (Pillow output)
  07. publish_queue           — canonical scheduling + delivery queue
  08. publish_logs            — immutable audit log of publish attempts
  09. engagement_targets      — user-defined engagement source universe
  10. engagement_opportunities — discovered posts/threads worth engaging
  11. engagement_actions      — AI-generated engagement drafts + execution records
  12. platform_metrics_daily  — normalized per-post daily metric snapshots
  13. social_roi_attribution  — business ROI from social activity
  14. plan_usage_daily        — content + engagement counters per org per day
  15. platform_daily_counters — platform safety cap counters (DB-backed, locked)

Revision ID: 001
Revises: (none — first migration)
Create Date: 2026-03-12
"""

from __future__ import annotations

from alembic import op

revision: str = "001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
    -- ──────────────────────────────────────────────────────────────────────────
    -- GROWTH SCHEMA
    -- ──────────────────────────────────────────────────────────────────────────
    CREATE SCHEMA IF NOT EXISTS growth;

    -- ── 01. brand_profiles ────────────────────────────────────────────────────
    -- Canonical brand identity used by all content generation.
    -- One row per org (UNIQUE org_id).
    CREATE TABLE growth.brand_profiles (
        id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id                uuid        NOT NULL,
        brand_name            text        NOT NULL,
        product_name          text,
        positioning           text,
        brand_summary         text,
        tone_json             jsonb,
        audience_json         jsonb,
        offer_json            jsonb,
        cta_rules_json        jsonb,
        content_pillars_json  jsonb,
        forbidden_claims_json jsonb,
        proof_points_json     jsonb,
        keywords_json         jsonb,
        competitors_json      jsonb,
        landing_pages_json    jsonb,
        default_timezone      text        NOT NULL DEFAULT 'UTC',
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now(),
        UNIQUE (org_id)
    );

    -- ── 02. social_accounts ──────────────────────────────────────────────────
    -- Connected social platform credentials.
    -- Tokens stored as Fernet-encrypted ciphertext — NEVER plaintext.
    -- meta_connection_id links Facebook + Instagram to a single Meta OAuth session.
    CREATE TABLE growth.social_accounts (
        id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id                  uuid        NOT NULL,
        platform                text        NOT NULL,
        account_type            text,
        platform_account_id     text        NOT NULL,
        display_name            text,
        access_token_enc        text        NOT NULL,   -- Fernet-encrypted
        refresh_token_enc       text,                   -- Fernet-encrypted, nullable
        token_expires_at        timestamptz,
        status                  text        NOT NULL DEFAULT 'connected',
        meta_json               jsonb,
        meta_connection_id      uuid,                   -- FK to parent Meta credential row
        last_sync_at            timestamptz,
        created_at              timestamptz NOT NULL DEFAULT now(),
        updated_at              timestamptz NOT NULL DEFAULT now(),
        UNIQUE (org_id, platform, platform_account_id),
        CHECK (platform IN ('linkedin', 'x', 'facebook', 'instagram')),
        CHECK (status  IN ('connected', 'disconnected', 'error', 'reauth_required'))
    );

    -- ── 03. org_growth_settings ──────────────────────────────────────────────
    -- Operational mode, plan keys, and limits per org.
    -- plan_key controls content posting entitlement.
    -- engagement_plan_key controls engagement automation entitlement.
    CREATE TABLE growth.org_growth_settings (
        id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id                      uuid        NOT NULL,
        posting_mode                text        NOT NULL DEFAULT 'suggestion_only',
        approval_required           boolean     NOT NULL DEFAULT true,
        daily_content_piece_limit   integer     NOT NULL DEFAULT 0,
        daily_engagement_limit      integer     NOT NULL DEFAULT 0,
        free_post_generations_used  integer     NOT NULL DEFAULT 0,
        free_image_generations_used integer     NOT NULL DEFAULT 0,
        free_generation_period_month date,
        max_connected_platforms     integer     NOT NULL DEFAULT 5,
        posting_windows_json        jsonb,
        platform_distribution_json  jsonb,
        engagement_targets_json     jsonb,
        auto_engagement_enabled     boolean     NOT NULL DEFAULT false,
        auto_safe_threshold         numeric(5,4),
        risk_block_threshold        numeric(5,4),
        timezone                    text        NOT NULL DEFAULT 'UTC',
        plan_key                    text        NOT NULL DEFAULT 'free',
        engagement_plan_key         text,
        created_at                  timestamptz NOT NULL DEFAULT now(),
        updated_at                  timestamptz NOT NULL DEFAULT now(),
        UNIQUE (org_id),
        CHECK (posting_mode IN ('auto', 'approval', 'suggestion_only')),
        CHECK (plan_key IN ('free', 'starter', 'growth', 'scale')),
        CHECK (
            engagement_plan_key IS NULL
            OR engagement_plan_key IN ('engagement_starter', 'engagement_pro')
        )
    );

    -- ── 04. content_ideas ────────────────────────────────────────────────────
    -- Output of the daily topic planner.
    -- Each idea is the source for one content piece (billing unit).
    CREATE TABLE growth.content_ideas (
        id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id      uuid        NOT NULL,
        source      text,                   -- 'planner_job' | 'manual' | etc.
        pillar      text,                   -- brand content pillar
        topic       text        NOT NULL,
        angle       text,
        hook_seed   text,
        score       numeric(8,4),
        status      text        NOT NULL DEFAULT 'generated',
        planned_for date,
        created_by  text,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        CHECK (status IN ('generated', 'selected', 'drafted', 'queued', 'published', 'rejected', 'archived'))
    );

    -- ── 05. content_variants ─────────────────────────────────────────────────
    -- Platform-specific content derived from one idea.
    -- Multiple variants per idea (one per platform) = still ONE content piece
    -- for billing purposes (locked rule §D).
    -- original_body_text preserved for edit history (locked directive §B).
    CREATE TABLE growth.content_variants (
        id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id              uuid        NOT NULL,
        idea_id             uuid        NOT NULL REFERENCES growth.content_ideas(id) ON DELETE CASCADE,
        platform            text        NOT NULL,
        format              text        NOT NULL,
        title_text          text,
        body_text           text,                   -- user-editable current version
        original_body_text  text,                   -- AI-generated original (never overwritten)
        caption_text        text,
        thread_json         jsonb,
        carousel_json       jsonb,
        hashtags_json       jsonb,
        cta_text            text,
        image_spec_json     jsonb,
        status              text        NOT NULL DEFAULT 'draft',
        quality_score       numeric(8,4),
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        CHECK (platform IN ('linkedin', 'x', 'facebook', 'instagram')),
        CHECK (format   IN ('post', 'thread', 'quote_card', 'carousel', 'image_caption', 'single_visual')),
        CHECK (status   IN ('draft', 'approved', 'queued', 'published', 'failed', 'rejected'))
    );

    -- ── 06. content_assets ───────────────────────────────────────────────────
    -- Rendered image assets (Pillow output) stored in Supabase Storage.
    CREATE TABLE growth.content_assets (
        id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id        uuid        NOT NULL,
        variant_id    uuid        REFERENCES growth.content_variants(id) ON DELETE SET NULL,
        asset_type    text        NOT NULL,
        storage_path  text        NOT NULL,   -- path in Supabase Storage bucket
        mime_type     text        NOT NULL,
        width         integer,
        height        integer,
        template_name text,
        meta_json     jsonb,
        created_at    timestamptz NOT NULL DEFAULT now(),
        CHECK (asset_type IN ('quote_card', 'stat_card', 'carousel_slide', 'single_visual', 'thumbnail'))
    );

    -- ── 07. publish_queue ────────────────────────────────────────────────────
    -- Canonical publishing queue.
    -- Locking model: workers use SELECT ... FOR UPDATE SKIP LOCKED.
    -- idempotency_key prevents double-posting on retry (UNIQUE constraint).
    CREATE TABLE growth.publish_queue (
        id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id                uuid        NOT NULL,
        platform              text        NOT NULL,
        variant_id            uuid        NOT NULL REFERENCES growth.content_variants(id),
        asset_id              uuid        REFERENCES growth.content_assets(id),
        scheduled_for         timestamptz NOT NULL,
        status                text        NOT NULL DEFAULT 'pending',
        attempt_count         integer     NOT NULL DEFAULT 0,
        max_attempts          integer     NOT NULL DEFAULT 5,
        locked_by             text,                   -- worker instance ID
        locked_until          timestamptz,
        last_error            text,
        published_platform_id text,                   -- platform-returned post ID
        published_url         text,
        idempotency_key       text        NOT NULL,
        created_at            timestamptz NOT NULL DEFAULT now(),
        updated_at            timestamptz NOT NULL DEFAULT now(),
        UNIQUE (idempotency_key),
        CHECK (platform IN ('linkedin', 'x', 'facebook', 'instagram')),
        CHECK (status IN (
            'pending', 'locked', 'scheduled', 'published',
            'failed', 'blocked_quota', 'blocked_auth', 'blocked_approval', 'cancelled'
        ))
    );

    -- ── 08. publish_logs ─────────────────────────────────────────────────────
    -- Immutable audit log of every publish attempt.
    -- Append-only — never UPDATE or DELETE rows.
    -- request_json and response_json must NOT contain plaintext OAuth tokens.
    CREATE TABLE growth.publish_logs (
        id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        queue_id      uuid        NOT NULL REFERENCES growth.publish_queue(id),
        org_id        uuid        NOT NULL,
        platform      text        NOT NULL,
        request_json  jsonb,
        response_json jsonb,
        http_status   integer,
        success       boolean     NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now()
    );

    -- ── 09. engagement_targets ───────────────────────────────────────────────
    -- User-defined sources for the engagement engine to scan.
    -- Engagement only happens within this declared target universe.
    CREATE TABLE growth.engagement_targets (
        id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id            uuid        NOT NULL,
        platform          text        NOT NULL,
        target_type       text        NOT NULL,
        target_identifier text        NOT NULL,
        target_url        text,
        priority          integer     NOT NULL DEFAULT 100,
        status            text        NOT NULL DEFAULT 'active',
        meta_json         jsonb,
        created_at        timestamptz NOT NULL DEFAULT now(),
        updated_at        timestamptz NOT NULL DEFAULT now(),
        CHECK (target_type IN ('keyword', 'hashtag', 'account', 'competitor', 'topic')),
        CHECK (status IN ('active', 'paused', 'archived'))
    );

    -- ── 10. engagement_opportunities ─────────────────────────────────────────
    -- Discovered candidate posts/threads the engagement engine may act on.
    CREATE TABLE growth.engagement_opportunities (
        id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id              uuid        NOT NULL,
        platform            text        NOT NULL,
        target_id           uuid        REFERENCES growth.engagement_targets(id),
        platform_object_id  text        NOT NULL,
        object_type         text        NOT NULL,
        author_handle       text,
        object_url          text,
        source_text         text,
        relevance_score     numeric(8,4),
        priority_score      numeric(8,4),
        status              text        NOT NULL DEFAULT 'pending',
        created_at          timestamptz NOT NULL DEFAULT now(),
        updated_at          timestamptz NOT NULL DEFAULT now(),
        CHECK (object_type IN ('post', 'comment', 'thread', 'mention', 'dm'))
    );

    -- ── 11. engagement_actions ───────────────────────────────────────────────
    -- AI-generated engagement drafts + execution records.
    -- original_proposed_text is never overwritten (audit trail).
    CREATE TABLE growth.engagement_actions (
        id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id              uuid        NOT NULL,
        platform            text        NOT NULL,
        opportunity_id      uuid        REFERENCES growth.engagement_opportunities(id),
        action_type         text        NOT NULL,
        proposed_text       text        NOT NULL,   -- AI-generated original
        posted_text         text,                   -- actual text posted (may differ if edited)
        confidence_score    numeric(8,4),
        risk_score          numeric(8,4),
        approval_status     text        NOT NULL DEFAULT 'not_required',
        execution_status    text        NOT NULL DEFAULT 'drafted',
        platform_action_id  text,
        created_at          timestamptz NOT NULL DEFAULT now(),
        approved_at         timestamptz,
        posted_at           timestamptz,
        CHECK (action_type IN ('comment', 'reply', 'dm_reply', 'discussion_start')),
        CHECK (approval_status IN ('not_required', 'pending', 'approved', 'rejected')),
        CHECK (execution_status IN ('drafted', 'queued', 'posted', 'failed', 'cancelled'))
    );

    -- ── 12. platform_metrics_daily ───────────────────────────────────────────
    -- Normalized per-post daily metric snapshots collected by nightly job.
    -- UNIQUE on (platform, platform_post_id, metric_date) prevents duplicate entries.
    CREATE TABLE growth.platform_metrics_daily (
        id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id            uuid        NOT NULL,
        platform          text        NOT NULL,
        platform_post_id  text        NOT NULL,
        variant_id        uuid        REFERENCES growth.content_variants(id),
        metric_date       date        NOT NULL,
        impressions       integer,
        likes             integer,
        comments          integer,
        shares            integer,
        clicks            integer,
        saves             integer,
        followers_delta   integer,
        profile_visits    integer,
        meta_json         jsonb,
        created_at        timestamptz NOT NULL DEFAULT now(),
        UNIQUE (platform, platform_post_id, metric_date)
    );

    -- ── 13. social_roi_attribution ───────────────────────────────────────────
    -- Business ROI attribution: social activity → GSC leads/meetings/deals.
    -- UTM parameters are appended to published post CTAs for tracking.
    CREATE TABLE growth.social_roi_attribution (
        id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id                  uuid        NOT NULL,
        platform                text        NOT NULL,
        variant_id              uuid        REFERENCES growth.content_variants(id),
        platform_post_id        text,
        utm_campaign            text,
        utm_source              text,
        utm_medium              text,
        clicks                  integer,
        leads_created           integer,
        meetings_booked         integer,
        deals_closed            integer,
        revenue_amount          numeric(18,2),
        currency                text        DEFAULT 'USD',
        attribution_window_days integer     DEFAULT 30,
        created_at              timestamptz NOT NULL DEFAULT now(),
        updated_at              timestamptz NOT NULL DEFAULT now()
    );

    -- ── 14. plan_usage_daily ─────────────────────────────────────────────────
    -- Content + engagement counters per org per day.
    -- UNIQUE (org_id, usage_date) — one row per org per day.
    -- Workers hold FOR UPDATE lock before incrementing any counter.
    CREATE TABLE growth.plan_usage_daily (
        id                          uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id                      uuid    NOT NULL,
        usage_date                  date    NOT NULL,
        content_pieces_generated    integer NOT NULL DEFAULT 0,
        content_pieces_published    integer NOT NULL DEFAULT 0,
        engagements_executed        integer NOT NULL DEFAULT 0,
        free_post_generations       integer NOT NULL DEFAULT 0,
        free_image_generations      integer NOT NULL DEFAULT 0,
        created_at                  timestamptz NOT NULL DEFAULT now(),
        updated_at                  timestamptz NOT NULL DEFAULT now(),
        UNIQUE (org_id, usage_date)
    );

    -- ── 15. platform_daily_counters ──────────────────────────────────────────
    -- Per-platform safety cap counters.
    -- Enforces: LinkedIn 2/day, X 8/day, Facebook 2/day, Instagram 2/day.
    -- Separate from plan_usage_daily because caps apply per-platform, per-org.
    -- Workers hold FOR UPDATE lock before incrementing.
    CREATE TABLE growth.platform_daily_counters (
        id                   uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id               uuid    NOT NULL,
        platform             text    NOT NULL,
        counter_date         date    NOT NULL,
        posts_published      integer NOT NULL DEFAULT 0,
        engagements_executed integer NOT NULL DEFAULT 0,
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now(),
        UNIQUE (org_id, platform, counter_date),
        CHECK (platform IN ('linkedin', 'x', 'facebook', 'instagram'))
    );

    -- ── Indexes ───────────────────────────────────────────────────────────────
    -- From spec (§2.9):
    CREATE INDEX idx_publish_queue_status_scheduled ON growth.publish_queue (status, scheduled_for);
    CREATE INDEX idx_publish_queue_locked_until      ON growth.publish_queue (locked_until);
    CREATE INDEX idx_content_ideas_org_status_date   ON growth.content_ideas (org_id, status, planned_for);
    CREATE INDEX idx_content_variants_org_platform   ON growth.content_variants (org_id, platform, status);
    CREATE INDEX idx_engagement_opps_org_platform    ON growth.engagement_opportunities (org_id, platform, status, priority_score DESC);
    CREATE INDEX idx_engagement_actions_org_date     ON growth.engagement_actions (org_id, platform, created_at DESC);
    CREATE INDEX idx_platform_metrics_org_date       ON growth.platform_metrics_daily (org_id, metric_date DESC);
    CREATE INDEX idx_plan_usage_org_date             ON growth.plan_usage_daily (org_id, usage_date DESC);

    -- Additional indexes:
    CREATE INDEX idx_social_accounts_org_platform    ON growth.social_accounts (org_id, platform, status);
    CREATE INDEX idx_content_variants_idea_id        ON growth.content_variants (idea_id);
    CREATE INDEX idx_platform_counters_org_date      ON growth.platform_daily_counters (org_id, platform, counter_date);
    CREATE INDEX idx_publish_logs_queue_id           ON growth.publish_logs (queue_id);
    CREATE INDEX idx_roi_attribution_org_platform    ON growth.social_roi_attribution (org_id, platform);
    """)


def downgrade() -> None:
    op.execute("""
    DROP SCHEMA IF EXISTS growth CASCADE;
    """)
