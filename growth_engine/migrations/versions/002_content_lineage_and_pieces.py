"""content lineage, pieces, experiments, authority ladders

Adds all schema objects required before Phase 2 content pipeline starts.
No data migration needed — all new tables and columns.

Changes:
  NEW  growth.content_pieces       — explicit billable unit (1 idea = 1 piece)
  NEW  growth.content_experiments  — A/B experiment tag per variant
  NEW  growth.authority_ladders    — ladder sequence state per org/theme
  ALTER growth.content_ideas       — add hook_candidates_json, authority_ladder_id
  ALTER growth.content_variants    — add 14 lineage + critic tracking columns

Lineage columns rationale (from critic.md §"content_variant_lineage"):
  These allow future analytics to answer: do contrarian hooks outperform?
  do regenerated drafts outperform first-pass? which prompt version works best?
  Without them you only know "post did well". With them you know WHY.

Revision ID: 002
Revises: 001
Create Date: 2026-03-12
"""

from __future__ import annotations

from alembic import op

revision: str = "002"
down_revision = "001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
    -- ── growth.content_pieces ─────────────────────────────────────────────────
    -- The explicit billable unit. One content piece = one idea run through the
    -- full pipeline for all connected platforms.
    -- Billing rule (locked §D): generating LinkedIn + X + Instagram variants
    -- from one idea still counts as 1 piece, not 3.
    -- Quota is incremented against content_pieces, never content_variants.
    CREATE TABLE growth.content_pieces (
        id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id      uuid        NOT NULL,
        idea_id     uuid        NOT NULL REFERENCES growth.content_ideas(id) ON DELETE CASCADE,
        status      text        NOT NULL DEFAULT 'drafting',
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        UNIQUE (idea_id),
        CHECK (status IN ('drafting', 'ready', 'queued', 'published', 'failed', 'cancelled'))
    );

    -- ── growth.authority_ladders ──────────────────────────────────────────────
    -- Tracks the state of an Authority Ladder sequence per org/theme.
    -- The system remembers which level is next so posts build on each other.
    -- Levels: observation → pattern_recognition → operational_insight →
    --         framework → authority_position → evidence → movement
    CREATE TABLE growth.authority_ladders (
        id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id           uuid        NOT NULL,
        theme            text        NOT NULL,
        current_level    integer     NOT NULL DEFAULT 1,
        completed_levels integer[]   NOT NULL DEFAULT '{}',
        status           text        NOT NULL DEFAULT 'active',
        meta_json        jsonb,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        CHECK (current_level BETWEEN 1 AND 7),
        CHECK (status IN ('active', 'completed', 'paused'))
    );

    -- ── growth.content_experiments ────────────────────────────────────────────
    -- Tags variants with A/B experiment metadata for future analysis.
    -- Examples: hook_style=contrarian, post_length=short, pillar=speed_to_lead
    -- One variant can have multiple experiment tags.
    CREATE TABLE growth.content_experiments (
        id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id           uuid        NOT NULL,
        variant_id       uuid        NOT NULL REFERENCES growth.content_variants(id) ON DELETE CASCADE,
        experiment_type  text        NOT NULL,
        experiment_value text        NOT NULL,
        created_at       timestamptz NOT NULL DEFAULT now()
    );

    -- ── Extend growth.content_ideas ───────────────────────────────────────────
    ALTER TABLE growth.content_ideas
        ADD COLUMN hook_candidates_json  jsonb,        -- hook tournament output (scored list)
        ADD COLUMN authority_ladder_id   uuid REFERENCES growth.authority_ladders(id),
        ADD COLUMN ladder_level          integer;      -- which ladder level this idea represents

    -- ── Extend growth.content_variants — 14 new columns ──────────────────────
    --
    -- Billable unit FK:
    --   piece_id          — links variant to its content_piece (billing unit)
    --
    -- Generation lineage (answers: how did this variant come to be?):
    --   angle_type        — e.g. contrarian, operational, framework, founder_story
    --   angle_title       — 5-10 word angle title chosen by angle generator
    --   core_claim        — single provocative statement the post builds around
    --   hook_text         — the winning hook from the hook tournament
    --   hook_rank         — rank of this hook in tournament (1 = winner)
    --   prompt_version    — e.g. "writer_v1", "writer_v2" for prompt traceability
    --   generation_attempt — 1 = first pass, 2+ = rewrite after critic feedback
    --   parent_variant_id — UUID of the variant this was rewritten from
    --
    -- Critic tracking (answers: what quality gate outcome was produced?):
    --   critic_decision   — "approve" | "revise" | "force_approved"
    --   critic_scores_json — {clarity, specificity, novelty, platform_fit,
    --                          commercial_relevance, non_genericness, insight_count}
    --   revision_brief    — the targeted rewrite instruction from the critic
    --
    -- User editing:
    --   is_user_edited    — true if user modified body_text after AI generation
    --   finalized_at      — timestamp when variant passed critic or hit max attempts
    --
    ALTER TABLE growth.content_variants
        ADD COLUMN piece_id             uuid        REFERENCES growth.content_pieces(id) ON DELETE CASCADE,
        ADD COLUMN angle_type           text,
        ADD COLUMN angle_title          text,
        ADD COLUMN core_claim           text,
        ADD COLUMN hook_text            text,
        ADD COLUMN hook_rank            integer,
        ADD COLUMN prompt_version       text,
        ADD COLUMN generation_attempt   integer     NOT NULL DEFAULT 1,
        ADD COLUMN parent_variant_id    uuid        REFERENCES growth.content_variants(id),
        ADD COLUMN critic_decision      text,
        ADD COLUMN critic_scores_json   jsonb,
        ADD COLUMN revision_brief       text,
        ADD COLUMN is_user_edited       boolean     NOT NULL DEFAULT false,
        ADD COLUMN finalized_at         timestamptz,
        ADD CONSTRAINT chk_critic_decision
            CHECK (critic_decision IS NULL OR critic_decision IN ('approve', 'revise', 'force_approved'));

    -- ── Indexes ───────────────────────────────────────────────────────────────
    CREATE INDEX idx_content_pieces_org       ON growth.content_pieces (org_id, status);
    CREATE INDEX idx_content_pieces_idea      ON growth.content_pieces (idea_id);
    CREATE INDEX idx_content_variants_piece   ON growth.content_variants (piece_id);
    CREATE INDEX idx_content_variants_parent  ON growth.content_variants (parent_variant_id) WHERE parent_variant_id IS NOT NULL;
    CREATE INDEX idx_content_experiments_var  ON growth.content_experiments (variant_id);
    CREATE INDEX idx_content_experiments_type ON growth.content_experiments (org_id, experiment_type, experiment_value);
    CREATE INDEX idx_authority_ladders_org    ON growth.authority_ladders (org_id, status);
    CREATE INDEX idx_content_ideas_ladder     ON growth.content_ideas (authority_ladder_id) WHERE authority_ladder_id IS NOT NULL;
    """)


def downgrade() -> None:
    op.execute("""
    ALTER TABLE growth.content_variants
        DROP CONSTRAINT IF EXISTS chk_critic_decision,
        DROP COLUMN IF EXISTS piece_id,
        DROP COLUMN IF EXISTS angle_type,
        DROP COLUMN IF EXISTS angle_title,
        DROP COLUMN IF EXISTS core_claim,
        DROP COLUMN IF EXISTS hook_text,
        DROP COLUMN IF EXISTS hook_rank,
        DROP COLUMN IF EXISTS prompt_version,
        DROP COLUMN IF EXISTS generation_attempt,
        DROP COLUMN IF EXISTS parent_variant_id,
        DROP COLUMN IF EXISTS critic_decision,
        DROP COLUMN IF EXISTS critic_scores_json,
        DROP COLUMN IF EXISTS revision_brief,
        DROP COLUMN IF EXISTS is_user_edited,
        DROP COLUMN IF EXISTS finalized_at;

    ALTER TABLE growth.content_ideas
        DROP COLUMN IF EXISTS hook_candidates_json,
        DROP COLUMN IF EXISTS authority_ladder_id,
        DROP COLUMN IF EXISTS ladder_level;

    DROP TABLE IF EXISTS growth.content_experiments;
    DROP TABLE IF EXISTS growth.authority_ladders;
    DROP TABLE IF EXISTS growth.content_pieces;
    """)
