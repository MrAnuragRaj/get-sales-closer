"""
Migration 012 — Revenue Attribution table.

Links engagement actions to lead conversions.
When an author we engaged with later appears as a lead in the org's CRM,
we record the attribution — answering "which engagements turned into leads?"

Match strategies (v1):
  messenger_psid — exact match: influencer_nodes.author_platform_id = leads.messenger_psid
                   confidence = 0.9
  author_name    — case-insensitive exact match: influencer_nodes.author_name = leads.name
                   confidence = 0.6

Only nodes where we actually engaged (engaged_count > 0) are matched.
New contacts discovered but never engaged with are excluded — we attribute
conversions to actual relationship-building, not passive observation.

Called by:
  POST /internal/run-attribution-sweep  (secret-gated, run on any schedule; daily is fine)
"""

revision:    str = "012"
down_revision    = "011"


upgrade_sql = """
CREATE TABLE IF NOT EXISTS growth.revenue_attributions (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id              UUID        NOT NULL
                        REFERENCES public.organizations(id) ON DELETE CASCADE,

    -- The CRM lead this engagement contributed to
    lead_id             UUID        NOT NULL,

    -- The influencer node (author) matched to this lead
    influencer_node_id  UUID
                        REFERENCES growth.influencer_nodes(id),

    -- The last engagement action before the lead was matched
    -- NULL if action history is unavailable at attribution time
    action_id           UUID,

    platform            TEXT        NOT NULL,

    -- How the match was made
    matched_on          TEXT        NOT NULL
                        CHECK (matched_on IN ('messenger_psid', 'author_name')),

    -- The actual value that was matched (e.g. the PSID string or the name string)
    -- Makes the attribution record self-contained and auditable without joining back
    match_value         TEXT,

    -- Confidence of this attribution (0.0 – 1.0)
    attribution_score   NUMERIC(4,3) NOT NULL,

    attributed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- One attribution per (org, lead, node) — prevents duplicates across re-runs
    UNIQUE (org_id, lead_id, influencer_node_id)
);

CREATE INDEX IF NOT EXISTS idx_revenue_attr_org
    ON growth.revenue_attributions(org_id, attributed_at DESC);

CREATE INDEX IF NOT EXISTS idx_revenue_attr_lead
    ON growth.revenue_attributions(lead_id);

CREATE INDEX IF NOT EXISTS idx_revenue_attr_node
    ON growth.revenue_attributions(influencer_node_id);
"""


downgrade_sql = """
DROP TABLE IF EXISTS growth.revenue_attributions CASCADE;
"""


async def upgrade(conn) -> None:
    await conn.execute(upgrade_sql)


async def downgrade(conn) -> None:
    await conn.execute(downgrade_sql)
