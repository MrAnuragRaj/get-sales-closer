"""
Migration 011 — Growth Graph: influencer nodes.

Tracks every unique author seen across engagement opportunities.
Used to:
  - prioritize scoring queue (known + engaged authors first, flag-controlled)
  - show relationship context in the dashboard UI

Tables:
  growth.influencer_nodes
    One row per (org_id, platform, author_platform_id) triple.
    seen_count    — incremented every time this author's post is discovered
    engaged_count — incremented every time we successfully execute on their post
    Relationship strength (derived) = engaged_count * 5 + seen_count

Columns added to existing tables:
  growth.engagement_opportunities.influencer_node_id — FK → influencer_nodes

Indexes:
  idx_influencer_nodes_org_platform  — fast lookup during discovery
  idx_influencer_nodes_id_engaged    — scoring worker join performance
"""

revision:    str = "011"
down_revision    = "010"


upgrade_sql = """
-- ── Influencer nodes ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS growth.influencer_nodes (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID        NOT NULL
                        REFERENCES public.organizations(id) ON DELETE CASCADE,
    platform            TEXT        NOT NULL,
    author_platform_id  TEXT        NOT NULL,
    author_name         TEXT,

    -- Familiarity signals — both derived from internal data only
    seen_count          INT         NOT NULL DEFAULT 1,
    last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Relationship signals
    engaged_count       INT         NOT NULL DEFAULT 0,
    last_engaged_at     TIMESTAMPTZ,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (org_id, platform, author_platform_id)
);

-- Fast lookup during discovery upsert and scoring worker join
CREATE INDEX IF NOT EXISTS idx_influencer_nodes_org_platform
    ON growth.influencer_nodes(org_id, platform);

-- Covers scoring worker join: ON n.id = o.influencer_node_id WITH n.engaged_count
CREATE INDEX IF NOT EXISTS idx_influencer_nodes_id_engaged
    ON growth.influencer_nodes(id, engaged_count);

-- ── FK on engagement_opportunities ───────────────────────────────────────────

ALTER TABLE growth.engagement_opportunities
    ADD COLUMN IF NOT EXISTS influencer_node_id UUID
        REFERENCES growth.influencer_nodes(id);
"""


downgrade_sql = """
ALTER TABLE growth.engagement_opportunities
    DROP COLUMN IF EXISTS influencer_node_id;

DROP TABLE IF EXISTS growth.influencer_nodes CASCADE;
"""


async def upgrade(conn) -> None:
    await conn.execute(upgrade_sql)


async def downgrade(conn) -> None:
    await conn.execute(downgrade_sql)
