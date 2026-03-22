"""
Migration 014 — Growth Radar: computed intelligence snapshot.

Creates growth.radar_snapshots — one active row per org, overwritten on
each refresh. Stores a pre-computed intelligence digest derived entirely
from data already accumulated by A–E (no new LLM calls, no live queries).

Fields:
  top_authors        — [{author_name, platform, seen_count, engaged_count, relationship_score}]
  top_angles         — [{angle_type, variant_count, avg_hook_score}]
  engagement_health  — {total_executed, success_rate, auto_approval_rate, avg_confidence}
  attribution_summary — {total_attributed, high_confidence_count}
  period_days        — rolling window used for time-bounded signals (default 30)
                       retained for future 7-day vs 30-day snapshot variants

Unique on org_id — ON CONFLICT DO UPDATE keeps only the latest snapshot.
"""

revision:    str = "014"
down_revision    = "013"


upgrade_sql = """
CREATE TABLE IF NOT EXISTS growth.radar_snapshots (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id               UUID        NOT NULL
                         REFERENCES public.organizations(id) ON DELETE CASCADE,

    -- Rolling window these signals were computed over
    period_days          INT         NOT NULL DEFAULT 30,

    -- Top authors by relationship strength (engaged_count * 5 + seen_count)
    top_authors          JSONB,

    -- Top content angles by usage + avg hook score
    top_angles           JSONB,

    -- Engagement health stats over period_days
    engagement_health    JSONB,

    -- Revenue attribution summary
    attribution_summary  JSONB,

    computed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One active snapshot per org — upsert overwrites
    UNIQUE (org_id)
);

CREATE INDEX IF NOT EXISTS idx_radar_snapshots_org
    ON growth.radar_snapshots(org_id);
"""


downgrade_sql = """
DROP TABLE IF EXISTS growth.radar_snapshots CASCADE;
"""


async def upgrade(conn) -> None:
    await conn.execute(upgrade_sql)


async def downgrade(conn) -> None:
    await conn.execute(downgrade_sql)
