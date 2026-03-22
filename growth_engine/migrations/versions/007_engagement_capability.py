"""007 — Phase 8: Engagement Capability Model + Rate Limiting

Changes:

  growth.social_accounts (ALTER):
    + publish_capable        BOOLEAN  — whether publish OAuth token/scopes are valid
    + engage_capable         BOOLEAN  — whether engagement OAuth token/scopes are valid
    + publish_status_reason  TEXT     — 'ok' | 'no_account' | 'token_expired' | etc.
    + engage_status_reason   TEXT     — 'ok' | 'no_account' | 'platform_unsupported' | etc.
    + scopes_json            JSONB    — OAuth scopes granted at connect time
    + last_capability_check  TIMESTAMPTZ — last time capability was evaluated

  growth.engagement_actions (ALTER):
    + error_category  TEXT  — canonical: AUTH_FAILED | RATE_LIMITED | RETRYABLE |
                              CONTENT_REJECTED | PLATFORM_DISABLED | PERMANENT

  growth.rate_limit_buckets (NEW TABLE):
    Per-org, per-route sliding window request counts.
    Used for transport-level rate limiting on expensive/dangerous routes.
    Window is bucketed by hour or day at write time (stored in window_start).
    Old buckets accumulate; the sweep endpoint purges rows older than 7 days.

Rationale:
  - Capability model: publish and engagement OAuth require different scopes.
    Tracking them independently prevents silent failures when a token is valid
    for publishing but lacks commenting scope.
  - error_category on actions: aligns with publisher error_normalizer pattern
    so analytics can reason about failure types, not just raw messages.
  - rate_limit_buckets: self-contained inside the Growth Engine schema, avoids
    coupling to main GSC rate_limit_buckets. These are transport limits, not
    commercial plan limits (those remain in engagement_daily_caps).

Revision ID: 007
Revises: 006
Create Date: 2026-03-12
"""

from __future__ import annotations

from alembic import op

revision: str = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""

    -- ── Capability columns on social_accounts ───────────────────────────────
    -- Track publish vs engage capability independently.
    -- Populated by the capability evaluation service after every connect/refresh.
    -- Defaults to false (unknown) until first evaluated.

    ALTER TABLE growth.social_accounts
        ADD COLUMN IF NOT EXISTS publish_capable       BOOLEAN     NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS engage_capable        BOOLEAN     NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS publish_status_reason TEXT,
        ADD COLUMN IF NOT EXISTS engage_status_reason  TEXT,
        ADD COLUMN IF NOT EXISTS scopes_json           JSONB,
        ADD COLUMN IF NOT EXISTS last_capability_check TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_social_accounts_capability
        ON growth.social_accounts (org_id, platform, engage_capable);


    -- ── error_category on engagement_actions ────────────────────────────────
    -- Canonical error category matching publisher error_normalizer:
    --   AUTH_FAILED | RATE_LIMITED | RETRYABLE | CONTENT_REJECTED |
    --   PLATFORM_DISABLED | PERMANENT | CAPABILITY_MISSING

    ALTER TABLE growth.engagement_actions
        ADD COLUMN IF NOT EXISTS error_category TEXT;


    -- ── Rate limit buckets ───────────────────────────────────────────────────
    -- Per-org sliding window counters for transport-level rate limiting.
    -- window_start is floored to the relevant time boundary (hour/day) at
    -- insert time, making UNIQUE (org_id, route_key, window_start) the bucket key.
    -- These are NOT commercial caps. Commercial caps are in engagement_daily_caps.

    CREATE TABLE IF NOT EXISTS growth.rate_limit_buckets (
        id           UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
        org_id       UUID        NOT NULL,
        route_key    TEXT        NOT NULL,
        window_start TIMESTAMPTZ NOT NULL,
        count        INTEGER     NOT NULL DEFAULT 0,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        UNIQUE (org_id, route_key, window_start)
    );

    CREATE INDEX IF NOT EXISTS idx_rate_limit_org_route
        ON growth.rate_limit_buckets (org_id, route_key, window_start DESC);

    """)


def downgrade() -> None:
    op.execute("""
    DROP TABLE IF EXISTS growth.rate_limit_buckets;

    ALTER TABLE growth.engagement_actions
        DROP COLUMN IF EXISTS error_category;

    ALTER TABLE growth.social_accounts
        DROP COLUMN IF EXISTS publish_capable,
        DROP COLUMN IF EXISTS engage_capable,
        DROP COLUMN IF EXISTS publish_status_reason,
        DROP COLUMN IF EXISTS engage_status_reason,
        DROP COLUMN IF EXISTS scopes_json,
        DROP COLUMN IF EXISTS last_capability_check;
    """)
